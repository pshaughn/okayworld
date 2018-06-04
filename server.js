"use strict"

/**
   An instance object contains:
   .pastHorizonFrameNumber: int
   .pastHorizonPerfTime: timestamp
   .pastHorizonState: a game state
   .pastHorizonControllerStatus: map from id numbers to controller status objects
   .events: map from int to list of events (not necessarily sorted yet)
   .broadcastControllers: map from id numbers to controllers
   .suspended: boolean, if true then pastHorizonPerfTime may be in the distance past
   .advanceTimeout: timeout handle for state advancing
   .playset: a playset

   A controller status object has .u username and .i last known input string (default "")

   A game state object should contain at least a controller-username mapping
   and game information relevant to the connected users, but it is a black box
   to the core server code and only the playset code needs to understand it.

   An event contains:
   .k: "c" connect, "d" disconnect, "o" command, "f" frame
   .f: int frame number
   .i: input string when .k=="f"
   .o: command string when .k=="o"
   .s: for "o" only, positive integer serial, always increasing within a frame
   .c: int controller number (not sent from client to server)
   .u: username when .k=="c" 
   .d: user config string when .k=="c" (mainly for use by client 
       user-management UI and playset ui 'avatar' assignment; is also 
       available to playset game state logic, but be wary of "modeling for
       advantage" customization)

   Canonical sort order of events:
   .k primary, "c"<"o"<"f"<"d"
   .c secondary, ordered as integer not string
   .s tertiary for "o", ordered as integer not string

   A controller object contains (mostly not until connection is established):
   .socket: websocket object (which has .okayController injected into it to point back)
   .username: string
   .config: user's config (as of moment of login)
   .instance: instance
   .minFrameNumber: int, events stamped earlier than this are out-of-order
   .timeout: handle to a cancelable timeout
   .lastCommandNumber: last command serial number for this frame, or 0

   A user object [not to be confused with a controller object] contains:
   .password ("hashed", though the hash function may sometimes be a no-op)
   .username: string, limited to ASCII
   .config: unicode string available to playset via connect events,
            server-validated only for length and not for content
   .selfServeAddress: if present, this user was created via self-serve from
                      this address
   .admin: boolean
   
   Server-to-client network messages:
   {k:"E", e:errorString} (error, hanging up)
   {k:"D", d:completionString} (successful api call, hanging up)
   any instance-controller event, which may additionally have "t" attached as a timing pong
   {k:"S", g:serializedGameState,  p:playsetName,
   x:{controllerID:{'u':username,'i':inputString}... },
   e:[instancecontrollerevents... unsorted],
   t:timingPong,
   c:controllerID, f:frameNumberOfSerializedState , r:fps}
   {k:"F"} (frame horizon has advanced)

   client-to-server network messages for normal login:
   "o" or "f" instance-controller events
   {k:"l", u:username, p:password, n:instanceName}   

   client-to-server network messages for self-serve API calls:
   {k:"selfServeCreateUser",u:username, p:password, d:config}
   {k:"changeMyPassword",u:username, p:password, n:newPassword, d:config}
   {k:"getMyConfig",u:username, p:password} (completion string is the config)
   {k:"setMyConfig",u:username, p:password, d:config}

   client-to-server network messages for admin API calls:
   {k:"dirtyShutdown",u:username, p:password, r:reason} (only forensic save)
   {k:"cleanShutdown",u:username, p:password, r:reason} (save for next startup)
   (later, admin versions of the self-serve operations)
   
   open issues not addressed here:
   - password hashing
   - saving out the state
   - automatic async state saving
   - rotating state saves to avoid data loss, loading the right one
   - revelation of hidden state/rng rolls
   - handling of partially hidden state
   - handling of hidden inputs
   - propagating data between different instances, and keeping that synced up
   - prevent simultaneous logins
   - delay login when previous quit hasn't processed yet
   - gating instances (e.g. whitelists, bans, need another instance's approval)
   - non-real-time instances for games without client-side prediction
   - user profile configuration
   - non-instance-specific messaging
   - admin operations for user management, including grant/revoke admin
   - fixed codes for error/success reasons
   
*/

const fs=require('fs');
const performance=require('perf_hooks').performance;
const crypto=require('crypto');

const ws=require('ws');

var httpServer;
var wsServer;

var config; // general server parameters
var users; // map from usernames to users
var instances; // map from instance names instance state objects
var controllers; // map from controller ID numbers to controller objects
var nextControllerID; // int
var selfServeUserCounts; // how many self-serve users there are from an IP

const FPS=30;
const PAST_HORIZON_FRAMES=FPS/2, FUTURE_HORIZON_FRAMES=FPS*3/2;
const TIMEOUT_MILLIS=5000;

const MIN_USERNAME_LENGTH=3;
const MAX_USERNAME_LENGTH=16;
const MIN_PASSWORD_LENGTH=3;
const MAX_PASSWORD_LENGTH=64;
const MAX_USER_CONFIG_LENGTH=10000;
const MAX_INBOUND_MESSAGE_LENGTH=20000;

const STATE_FILENAME="./serverstate.json";

var playsets;

function registerPlayset(playset) {
 if(!("serializeGameState" in playset)) {
  playset.serializeGameState=function(gameState) {
   return JSON.stringify(gameState);
  }
 }
 if(!("deserializeGameState" in playset)) {
  playset.deserializeGameState=function(gameStateString) {
   return JSON.parse(gameStateString);
  }
 }
 // server doesn't call copy or advanceClient so doesn't need their defaults
 playsets[playset.getName()]=playset;
}

function getPlayset(name) {
 return playsets[name]||null;
}

function loadPlaysets() {
 // assumption for now: we're only calling this once
 // and don't need reload logic
 global.registerPlayset=registerPlayset
 playsets={}
 require("./web/playsets.js")
 delete global.registerPlayset
}


function initServer() {
 const cert=require('./cert.js')
 loadPlaysets();
 loadServerState();
 if(cert.secure) {
  const https=require('https')
  httpServer=https.createServer({
   cert:fs.readFileSync(cert.fullchain),
   key:fs.readFileSync(cert.privkey),
  });
 }
 else {
  const http=require('http')
  httpServer=http.createServer();
 } 
 wsServer=new ws.Server({
  server:httpServer,
  maxLength:8192
 });
 wsServer.on('connection',onSocketConnection);
 httpServer.listen(8081);
}

function serializeServerState() {
 var o={
  config:config,
  users:users,
  nextControllerID:nextControllerID,
  instances:{}
 }
 for(var i in instances) {
  var instance=instances[i];
  var playset=instance.playset;
  o.instances[i]={
   playsetName:playset.getName(),
   state:playset.serializeGameState(instance.pastHorizonState),
   controllerStatus:instance.pastHorizonControllerStatus,
  }
 }
 return JSON.stringify(o,null,1);
}

function loadServerState() {
 // for now we're just loading state from a single file, not looking
 // at filenames to pick one
 var o=JSON.parse(fs.readFileSync("./serverstate.json"));
 config=o.config||{};
 selfServeUserCounts={}
 users=o.users;
 for(var username in users) {
  var u=users[username]
  if("selfServeAddress" in u) {
   selfServeUserCounts[u.selfServeAddress]=
    (selfServeUserCounts[u.selfServeAddress]||0)+1;
  }
  if(u.plaintextPassword) {
   u.password=makePasswordHash(u.plaintextPassword);
   delete u.plaintextPassword;
  }
  if(!("config" in u)) { u.config=""; }
 }
 nextControllerID=o.nextControllerID;
 controllers={}
 instances={}
 for(var k in o.instances) {
  var inst=o.instances[k];  
  var playset=getPlayset(inst.playsetName);
  var state=inst.state
  if(typeof(state)=="string") {
   // convenience: manual serverstate.json can use an unescaped object
   // for a simple game state. automatic persisting will always go
   // through serializer.
   state=playset.deserializeGameState(state);
  }
  // convenience: manual serverstate.json can omit controller info.
  // automatic persisting needs to include it so that any controllers
  // that were connected as of persist time get disconnect game events 
  // on rehydrating.
  var controllerStatus=("controllerStatus" in inst)?inst.controllerStatus:{};
  
  instances[k]={
   playset:playset,
   pastHorizonFrameNumber:1,
   pastHorizonState:state,
   pastHorizonPerfTime:performance.now()-PAST_HORIZON_FRAMES*FPS/1000,
   pastHorizonControllerStatus:controllerStatus,
   events:{1:[]},
   broadcastControllers:{},
   suspended:true,
  };
  // any controllers that were connected at save time are disconnected
  // now, let the game state find out when computing from frame 1 to frame 2
  for(var c in inst.controllerStatus) {
   instances[k].events[1].push({"k":"d","c":c|0,"f":1});
  }
 }
}


function onSocketConnection(socket,request) {
 var controller={
  id:nextControllerID,
  socket:socket,
  remoteAddress:request.connection.remoteAddress,
 }
 socket.on('message',onSocketMessage);
 socket.on('error',onSocketError);
 socket.on('close',onSocketClose); 
 socket.okayController=controller;
 resetConnectionTimeout(controller);
 controllers[nextControllerID]=controller;
 ++nextControllerID;
}

function resetConnectionTimeout(controller) {
 if(controller.timeout)
 {
  clearTimeout(controller.timeout);
 }
 controller.timeout=setTimeout(
  function() {
   handleControllerTimeout(controller);
  },
  TIMEOUT_MILLIS
 );
}

function abandonConnectionTimeout(controller) {
 if(controller.timeout)
 {
  clearTimeout(controller.timeout);
 }
}

function handleControllerTimeout(controller) {
 //console.log("tick (controller timeout)");
 controllerError(controller,"connection timed out");
}

function onSocketMessage(e) {
 var controller=this.okayController;
 if(controller.disconnected)
 {
  //console.log("ignoring message from disconnected controller",e);
  return;
 }
 try {
  var message=JSON.parse(e);
 }
 catch(err) {
  controllerError(controller,"server could not parse network message");
  return;
 }
 switch(message.k) {
  // normal flow
 case "f": onFrameMessage(controller,message); break;
 case "o": onCommandMessage(controller,message); break;
 case "l": onLoginMessage(controller,message); break;
  // API calls
 case "selfServeCreateUser": onCreateUserMessage(controller,message); break;
 case "changeMyPassword": onChangePasswordMessage(controller,message); break;
 case "getMyConfig": onGetConfigMessage(controller,message); break;
 case "setMyConfig": onSetConfigMessage(controller,message); break;
 case "dirtyShutdown": case "cleanShutdown":
  onShutdownMessage(controller,message);
  break;
 default:
  controllerError(controller,"unknown message type");
  break;
 }
}

function onSocketError() {
 var controller=this.okayController;
 if(controller.disconnected) { return; }
 controllerError(controller,"server detected network error");
}

function onSocketClose() {
 var controller=this.okayController;
 if(controller.disconnected) { return; }
 disconnectController(controller);
}

function makePasswordHash(password) {
 var salt=crypto.randomBytes(4).toString('hex');
 var hash=crypto.createHash('sha256');
 hash.update(salt);
 hash.update(password+"");
 return salt+"#"+hash.digest('hex');
}

function doesPasswordMatchHash(password,hashWanted) {
 var salt=hashWanted.slice(0,hashWanted.indexOf("#"));
 var hash=crypto.createHash('sha256');
 hash.update(salt);
 hash.update(password+"");
 var digest=hash.digest('hex');
 return hashWanted==salt+"#"+digest
}

function onLoginMessage(controller,message) {

 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 var instanceName=message.n+"";
 if(!(instanceName in instances)) {
  controllerError(controller,"instance name does not exist");
  return;
 }
 var instance=instances[instanceName];
 var instanceFrameNow=getPresentFrameNumber(instance);
 controller.username=""+message.u;
 controller.lastCommandNumber=0;
 controller.minFrameNumber=instanceFrameNow;
 controller.instance=instances[instanceName];
 var connectEvent={
  "c":controller.id,
  "u":controller.username,
  "f":instanceFrameNow,
  "d":users[controller.username].config,
  "k":"c"
 };
 unsuspendInstance(controller.instance);
 broadcastEventToInstance(controller.instance,connectEvent,false);
 subscribeControllerToBroadcasts(controller);
 sendInstanceSnapshot(controller);
 resetConnectionTimeout(controller);
}


function controllerError(controller,errorString) {
 try {
  controller.socket.send(JSON.stringify({k:"E",e:errorString}));
 }
 catch(e) {
 };
 try {
  controller.socket.close();
 }
 catch(e) {
 };
 disconnectController(controller);
}

function controllerDone(controller,resultString) {
 try {
  controller.socket.send(JSON.stringify({k:"D",d:resultString}));
 }
 catch(e) {
 };
 try {
  controller.socket.close();
 }
 catch(e) {
 };
 disconnectController(controller);
}

function disconnectController(controller) {
 if(controller.instance) {
  var frameNumber=getPresentFrameNumber(controller.instance);
  if(frameNumber<controller.minFrameNumber) {
   frameNumber=controller.minFrameNumber;
  }  
  unsubscribeControllerFromBroadcasts(controller);
  var disconnectEvent={
   "c":controller.id,
   "f":frameNumber,
   "k":"d",
  }
  broadcastEventToInstance(controller.instance,disconnectEvent,false);
 }
 abandonConnectionTimeout(controller);
 if(controller.id in controllers) {
  delete controllers[controller.id]
 }
 controller.disconnected=true;
}

function onFrameMessage(controller,message) {
 if(validateFrameOrCommandMessage(controller,message)) {
  controller.minFrameNumber=message.f+1;
  controller.lastCommandNumber=0;
  var event={
   "c":controller.id,
   "f":message.f,
   "k":"f",
   "i":""+message.i
  };
  broadcastEventToInstance(controller.instance,event,true);
  resetConnectionTimeout(controller);
 }
 // else we either errored out, or we are refusing to acknowledge an out-of-date event
}

function onCommandMessage(controller,message) {
 if(validateFrameOrCommandMessage(controller,message)) {
  var serial=message.s|0;
  if(!serial) {
   controllerError(controller,"client sent command message without serial");
  }
  if(serial<=controller.lastCommandNumber) {
   controllerError(controller,"client sent out-of-order command message");
  }
  var event={
   "c":controller.id,
   "f":message.f,
   "k":"o",
   "o":""+message.o,
   "s":serial,
  }
  controller.lastCommandNumber=serial;
  broadcastEventToInstance(controller.instance,event,false);
  resetConnectionTimeout(controller);
 }
 // else we either errored out, or we are refusing to acknowledge an out-of-date event
}

function validateFrameOrCommandMessage(controller,message) {
 if(!("f" in message)) {
  controllerError(controller,"malformed message, no frame number");
  return false
 }
 if(message.f !== message.f|0) {
  controllerError(controller,"malformed message, non-integer frame number");
  return false
 }
 if((message.f|0)<controller.minFrameNumber) {
  controllerError(controller,"out-of-order message");
  return false
 }
 var present=getPresentFrameNumber(controller.instance); 
 if((message.f|0)>present+FUTURE_HORIZON_FRAMES) {
  controllerError(controller,"client timestamps are running too fast");
  return false
 }
 if(message.f<controller.instance.pastHorizonFrameNumber) {
  // invalid, but in a "don't ack this, it's too lagged" way rather than a
  // constraint violation
  return false;
 }
 return true;
}

function validateUsername(username,controller) {
 if(username.length<MIN_USERNAME_LENGTH) {
  controllerError(controller,"username too short, minimum "+MIN_USERNAME_LENGTH);
  return false
 }
 if(username.length>MAX_USERNAME_LENGTH) {
  controllerError(controller,"username too short, minimum "+MAX_USERNAME_LENGTH);
  return false
 }
 for(var i=0;i<username.length;++i) {
  var code=username.codePointAt(i);
  if( (code<65 || code>90) && (code<97 || code>122)  &&
      (code<48 || code>57)) {
   controllerError(controller,"usernames must be ASCII alphanumeric");
   return false
  }
  if(i==0 && code>=48 && code<=57) {
   controllerError(controller,"usernames may not start with a number");
   return false;
  }
 }
 return true;
}

function validatePassword(password,controller) {
 if(typeof(password)!="string") {
  controllerError(controller,"malformed password data (not a Unicode string)");
  return false
 }
 if(password.length<MIN_PASSWORD_LENGTH) {
  controllerError(controller,"password too short, minimum "+MIN_PASSWORD_LENGTH);
  return false
 }
 if(password.length>MAX_PASSWORD_LENGTH) {
  controllerError(controller,"password too short, minimum "+MAX_PASSWORD_LENGTH);
  return false
 }
 // any unicode string in the right range is fine, no need to get weird
 return true;
}

function validateUserConfigLength(config,message) {
 if(config.length>MAX_USER_CONFIG_LENGTH) {
  controllerError(controller,"user config data is too long");
  return false
 }
 return true;
}

function onCreateUserMessage(controller,message) {
 // later: alternate flow for the admin version of the message
 var usernameWanted=message.u+"";
 if(!validateUsername(usernameWanted,controller)) { return; }
 // for passwords, validate type instead of coercing, to avoid
 // accidental "undefined" or "[object Object]" passwords
 var passwordWanted=message.p; 
 if(!validatePassword(passwordWanted,controller)) { return; }
 var configWanted=(message.c||"")+"";
 if(!validateUserConfigLength(configWanted,controller)) { return; }
 var existingCount=selfServeUserCounts[controller.remoteAddress]||0;
 if(!("selfServeUserLimit" in config) ||
    existingCount>=config.selfServeUserLimit) {
  controllerError(controller,
		  "you are not authorized for self-serve user creation");
 }
 if(usernameWanted in users) {
  controllerError(controller,
		  "username already in use");
 }
 users[usernameWanted]={
  username:usernameWanted,
  password:makePasswordHash(passwordWanted),
  config:configWanted,
  admin:false,
  selfServeAddress:controller.remoteAddress
 }
 selfServeUserCounts[controller.remoteAddress]=existingCount+1;
 controllerDone(controller,"user created");
}

function onChangePasswordMessage(controller,message) {
 // later: alternate flow for the admin version of the message
 var passwordWanted=message.p+"";
 if(!validatePassword(passwordWanted,controller)) { return; }
 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 users[message.u].password=makePasswordHash(passwordWanted);
 controllerDone(controller,"password changed");
}

function onGetConfigMessage(controller,message) {
 // later: alternate flow for the admin version of the message
 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 controllerDone(controller,users[message.u].config);
}


function onSetConfigMessage(controller,message) {
 // later: alternate flow for the admin version of the message
 var configWanted=(message.c||"")+"";
 if(!validateUserConfigLength(configWanted,controller)) { return; }
 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 users[message.u].config=configWanted;
}

function onShutdownMessage(controller,message) {
 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 if(!users[message.u].admin) {
  controllerError(controller,"you are not authorized to shut down the server");
  return;
 }

 controllerDone(controller,"shutdown in progress"); 

 var reason=(message.r+"")||"server shutdown"
 
 var controllerIDs=Object.getOwnPropertyNames(controllers);
 for(var i in controllerIDs) {
  controllerError(controllers[controllerIDs[i]],reason);
 }
 
 var toSave=serializeServerState();
 var d=new Date();
 var timeString=d.toISOString().replace(/:/g,"_"); 

 var saveFilename;
 
 // later: make save rotations cleaner to allow for better daemonization
 if(message.k=="cleanShutdown") {
  saveFilename="statebackup_"+timeString+".json";
  fs.writeFileSync(saveFilename,toSave);
  fs.writeFileSync(STATE_FILENAME,toSave);
 }
 else {
  saveFilename="dirtystate_"+timeString+".json";
  fs.writeFileSync(saveFilename,toSave);
 }
 wsServer.close();
 httpServer.close();
 console.log("Shut down, state backup is to "+saveFilename);
 if(message.r) { 
  console.log("Reason: "+reason);
 }
}

function subscribeControllerToBroadcasts(controller) {
 controller.instance.broadcastControllers[controller.id]=controller;
}

function unsubscribeControllerFromBroadcasts(controller) {
 if(controller.id in controller.instance.broadcastControllers) {
  delete controller.instance.broadcastControllers[controller.id];
 }
}

function addInstanceEvent(instance,event) {
 if(!instance.events[event.f]) {
  instance.events[event.f]=[event];
 }
 else {
  instance.events[event.f].push(event);
 }
}

function broadcastEventToInstance(instance,event,addTimestamp) {
 addInstanceEvent(instance,event);
 var msg=JSON.stringify(event);
 for(var i in instance.broadcastControllers) {
  var controller=instance.broadcastControllers[i];
  try {
   if(addTimestamp && (i|0)==event.c) {
    var injected={}
    for(var k in event) { injected[k]=event[k]; }
    injected.t=getTimingPongForInstance(instance);
    controller.socket.send(JSON.stringify(injected));
   }
   else {
    controller.socket.send(msg);
   }
  }
  catch(e) {
   controllerError(controller,"server could not send event");
  }
 }
}

function sendInstanceSnapshot(controller) {
 var instance=controller.instance;
 var eventsPile=[]
 for(var key in instance.events) {
  var forFrame=instance.events[key];
  for(var i=0;i<forFrame.length;++i) {
   eventsPile.push(forFrame[i]);
  }
 } 
 var snapshot={
  k:"S",
  p:instance.playset.getName(),
  c:controller.id,
  x:instance.pastHorizonControllerStatus,
  g:instance.playset.serializeGameState(instance.pastHorizonState),
  f:instance.pastHorizonFrameNumber,
  e:eventsPile,
  t:getTimingPongForInstance(instance),
  r:FPS,
 }
 controller.socket.send(JSON.stringify(snapshot)); 
}

function getPresentFrameNumber(instance) {
 return instance.pastHorizonFrameNumber+PAST_HORIZON_FRAMES
}

function getTimingPongForInstance(instance) {
 // pretending this instance has never been suspended,
 // what is the difference between perftime now and
 // perftime at frame zero? This should stay near
 // getPresentFrameNumber*1000/FPS as frames advance in an
 // unsuspended instance.
 var timeZero=instance.pastHorizonPerfTime-
     (instance.pastHorizonFrameNumber*1000/FPS);
 return performance.now()-timeZero;
}

function unsuspendInstance(instance) {
 if(instance.suspended) {
  instance.suspended=false;
  var freshHorizon=performance.now()-PAST_HORIZON_FRAMES*1000/FPS;
  if(freshHorizon>instance.pastHorizonPerfTime) {
   instance.pastHorizonPerfTime=freshHorizon;
  }
  scheduleAdvance(instance);
 }
}

function suspendInstance(instance) {
 if(!instance.suspended) {
  instance.suspended=true;
  clearTimeout(instance.advanceTimeout);
 }
}

function scheduleAdvance(instance) {
 if(instance.suspended) { return; }
 var nextFrameTime=instance.pastHorizonPerfTime+
     (PAST_HORIZON_FRAMES+1)*1000/FPS;
 var wait=nextFrameTime-performance.now();
 if(wait<0) { wait=0; } 
 setTimeout(function() {
  onAdvanceTimeout(instance);
 },wait);
}

function onAdvanceTimeout(instance) {
 //console.log("tick (stateAdvance timeout)");
 var now=performance.now();
 var nextFrameTime=instance.pastHorizonPerfTime+
     (PAST_HORIZON_FRAMES+1)*1000/FPS;
 while(now>=nextFrameTime) {
  advanceHorizonState(instance);
  instance.pastHorizonPerfTime+=1000/FPS;
  nextFrameTime+=1000/FPS;
 }
 if(Object.getOwnPropertyNames(instance.events).length==0 &&
    Object.getOwnPropertyNames(instance.broadcastControllers).length==0){
  suspendInstance(instance);
  //console.log("suspending")
  instance.advanceTimeout=null;
 }
 else {
  //console.log("scheduling frame re-check")
  scheduleAdvance(instance);
 }
}

const EVENT_KIND_ORDERING={"c":0,"o":1,"f":2,"d":3}

function instanceEventComparator(a,b) {
 var ak=EVENT_KIND_ORDERING[a.k], bk=EVENT_KIND_ORDERING[b.k]
 if(ak<bk) { return -1; } if(ak>bk) { return 1; }
 if(a.u<b.u) { return -1; } if(a.u>b.u) { return 1; }
 if(a.s<b.s) { return -1; } if(a.s>b.s) { return 1; }
 return 0;
}

function integerComparator(a,b) {
 if(a<b) { return -1; } if(a>b) { return 1; } return 0;
}

function advanceHorizonState(instance) {
 var events=instance.events[instance.pastHorizonFrameNumber];
 if(events) { delete instance.events[instance.pastHorizonFrameNumber]; }
 else { events=[]; }

 var connects=[];
 var commands=[];
 var inputs=[];
 var disconnects=[];
 events.sort(instanceEventComparator);
 
 for(var i in events) {
  if(events[i].k=="c") {
   instance.pastHorizonControllerStatus[events[i].c]={u:events[i].u,i:""};
   connects.push({"c":events[i].c,"u":events[i].u,"d":events[i].d});
  }
  if(events[i].k=="o") {
   commands.push({"c":events[i].c,"o":events[i].o});
  }
  if(events[i].k=="f") {
   if(events[i].c in instance.pastHorizonControllerStatus) {
    instance.pastHorizonControllerStatus[events[i].c].i=events[i].i;
   }
   else {
    // this is bad!
    
    console.error("frame event received from a controller that should not be able to send events to this instance.");
    console.error("event list: ",events[i]);
    console.error("controller status: ",instance.pastHorizonControllerStatus);
    throw new Error("event order invariant violation");
    
   }
  }
  if(events[i].k=="d") {
   disconnects.push(events[i].c);
  }
 }
 var controllersConnected=Object.getOwnPropertyNames(instance.pastHorizonControllerStatus);
 controllersConnected.sort(integerComparator);
 for(var i in controllersConnected) {
  var c=controllersConnected[i];
  inputs.push({"c":c,"i":instance.pastHorizonControllerStatus[c].i});  
 }
 instance.playset.advanceGameState(instance.pastHorizonState,
				   connects,commands,inputs,disconnects);
 for(var i in disconnects) {
  delete instance.pastHorizonControllerStatus[disconnects[i]];
 }
 ++instance.pastHorizonFrameNumber;
 var msg=JSON.stringify({"k":"F"});
 for(var i in instance.broadcastControllers) {
  var controller=instance.broadcastControllers[i];
  try {
   controller.socket.send(msg);
  }
  catch(e) {
   controllerError(controller,"server could not send event");
  }
 }
}

if(require.main==module) {
 initServer();
}
