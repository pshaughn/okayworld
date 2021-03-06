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
   .t: pong timestamp, only when echoing .k=="f" from client to server
 

   Canonical sort order of events:
   .k primary, "c"<"o"<"f"<"d"
   .c secondary, ordered as integer not string
   .s tertiary for "o", ordered as integer not string

   A controller object contains (mostly not until connection is established):
   .socket: websocket object (which has .okayController injected into it to point back)
   .username: string
   .config: user's config (as of moment of login)
   .instance: instance
   .instanceName: instance name
   .playsetName: instance.playset name
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
   {k:"U", l:[instanceName... ordered], n:defaultInstanceName} (prelogin)
   any instance-controller event, which may additionally have "t" attached as a timing pong
   {k:"W", t:timingPong} (login wait, with initial pong time)
   {k:"S", g:serializedGameState,  p:playsetName,
   x:{controllerID:{'u':username,'i':inputString}... },
   e:[instancecontrollerevents... unsorted],
   c:controllerID, f:frameNumberOfSerializedState, 
   m:initialChatTokenCount, l:chatMessageMaxLength, r:fps} (login)
   {k:"F", f: frameNumber} (frame horizon has advanced)
   {k:"F", f: frameNumber, h: hash} (above, and client should sync-test)
   {k:"g",c:controllerID,u:username,m:message} (global chat)
   {k:"G", n:messageCount} (granting client permission to send n 
                            global chat messages; this adds to previous
			    unspent permissions if any)

   client-to-server network messages for normal login:
   "o" or "f" instance-controller events
   array of "o" or "f" instance-controller events
   {k:"l", u:username, p:password, n:instanceName}   
   {k:"g",m:message}

   client-to-server network messages for self-serve API calls:
   {k:"prelogin"} no credentials needed, return info for login page
   {k:"selfServeCreateUser",u:username, p:password, d:config}
   {k:"changeMyPassword",u:username, p:password, n:newPassword, d:config}
   {k:"getMyConfig",u:username, p:password} (completion string is the config)
   {k:"setMyConfig",u:username, p:password, d:config}

   client-to-server network messages for admin API calls:
   {k:"dirtyShutdown",u:username, p:password, r:reason} (only forensic save)
   {k:"cleanShutdown",u:username, p:password, r:reason} (save for next startup)
   (later, admin versions of the self-serve operations)
   
   open issues not addressed here:
   - state saving as anything other than a shutdown
   - local port for admin operations
   - rotating state saves to avoid data loss, loading the right one
   - revelation of hidden state/rng rolls
   - handling of partially hidden state
   - handling of hidden inputs
   - propagating data between different instances, and keeping that synced up
   - gating instances (e.g. whitelists, bans, need another instance's approval)
   - non-real-time instances for games without client-side prediction
   - non-instance-specific messaging
   - admin operations for user management, including grant/revoke admin
   - fixed codes for error/success reasons
   - (client-side) breaking long message arrays down to stay under max length
   
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

// maps from usernames to controller objects
var inboxControllers, liveControllers, outboxControllers;

var requiredOrigin; // if using https, need this origin or local loopback

const FPS=30;
const PAST_HORIZON_FRAMES=FPS/2, FUTURE_HORIZON_FRAMES=FPS*3/2;
const TIMEOUT_MILLIS=5000;
const DEFAULT_HASH_SYNC_INTERVAL=FPS*5;
const DEFAULT_FRAME_BROADCAST_INTERVAL=FPS/4;
const DEFAULT_MAX_CHAT_MESSAGE_LENGTH=1024;
const DEFAULT_CHAT_BURST_SIZE=5;
const DEFAULT_CHAT_WAIT_MILLIS=2000;

const MIN_USERNAME_LENGTH=3;
const MAX_USERNAME_LENGTH=16;
const MIN_PASSWORD_LENGTH=3;
const MAX_PASSWORD_LENGTH=64;
const MAX_USER_CONFIG_LENGTH=10000;
const MAX_INBOUND_MESSAGE_LENGTH=20000;

// set this true if hashes are desyncing and you want lots of
// console output about it
const DUMP_HASH_STATES=false;

const STATE_FILENAME="./serverstate.json";

var playsets;

var playsetCommandRateLimits;
var playsetInputLengthLimits;
var playsetArgumentLengthLimits;


function defaultPlaysetAdvanceGameState(state,connects,
					commands,inputs,disconnects) {
 // exact cutpaste between client and server code
 for(var i in connects) {
  this.applyConnect(state,connects[i].c,connects[i].u,connects[i].d);
 }
 var controllerCommands={}
 for(var i in commands) {
  if(this.applyCommand) {
   this.applyCommand(state,commands[i].c,commands[i].o,commands[i].a);
  }
  if(commands[i].c in controllerCommands) {
   controllerCommands[commands[i].c].push({o:commands[i].o,a:commands[i].a});
  }
  else {
   controllerCommands[commands[i].c]=[{o:commands[i].o,a:commands[i].a}]
  }
 }
 for(var i in inputs) {
    this.applyControllerFrame(state,inputs[i].c,inputs[i].i,
			      controllerCommands[inputs[i].c]||[]);
 }
 if(this.applyStateFrame) { this.applyStateFrame(state); }
 for(var i in disconnects) {
  this.applyDisconnect(state,disconnects[i]);
 }
}

function registerPlayset(playset) {
 var defaultSerialization=true
 if(!("serializeGameState" in playset)) {
  playset.serializeGameState=function(gameState) {
   return JSON.stringify(gameState);
  }
 }
 else {
  defaultSerialization=false;
 } 
 if(!("deserializeGameState" in playset)) {
  playset.deserializeGameState=function(gameStateString) {
   return JSON.parse(gameStateString);
  }
 }
 else {
  defaultSerialization=false;
 }
 if(defaultSerialization && !("hashGameState" in playset)) {
  playset.hashGameState=defaultGameStateHash;
 }
 var name=playset.getName();
 
 // server doesn't call copy or advanceClient so doesn't need their defaults
 playsets[playset.getName()]=playset;
 if(playset.getCommandLimits) {
  playsetCommandRateLimits[name]=playset.getCommandLimits();
 }
 else {
  playsetCommandRateLimits[name]={}
 }

 if(playset.getInputLengthLimit) {
  playsetInputLengthLimits[name]=playset.getInputLengthLimit();
 }
 else {
  // setting default too high to have an effect, since the message would get
  // the user kicked anyway
  playsetInputLengthLimits[name]=MAX_INBOUND_MESSAGE_LENGTH;
 }

 if(playset.getArgumentLengthLimit) {
  playsetArgumentLengthLimits[name]=playset.getArgumentLengthLimit();
 }
 else {
  playsetArgumentLengthLimits[name]=MAX_INBOUND_MESSAGE_LENGTH;
 }

 if(!("advanceGameState" in playset)) {
  playset.advanceGameState=defaultPlaysetAdvanceGameState;
 }
}

function getPlayset(name) {
 return playsets[name]||null;
}

function loadPlaysets() {
 // assumption for now: we're only calling this once
 // and don't need reload logic
 global.registerPlayset=registerPlayset
 playsets={}
 playsetInputLengthLimits={}
 playsetArgumentLengthLimits={}
 playsetCommandRateLimits={} 
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
  requiredOrigin=cert.origin;
 }
 else {
  const http=require('http')
  httpServer=http.createServer();
  requiredOrigin=null;
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
 liveControllers={}
 inboxControllers={}
 outboxControllers={}
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
 var isLocal=(request.connection.remoteAddress=="::1" ||
	      request.connection.remoteAddress=="127.0.0.1" ||
	      request.connection.remoteAddress=="::ffff:127.0.0.1"); 
 if(!isLocal && requiredOrigin && request.headers.origin!=requiredOrigin) {
  try {
   socket.send(JSON.stringify({"k":"E","e":"origin header mismatch"}));
  }
  catch(e) { }
  try {
   socket.close();
  }
  catch(e) { }
  return;
 }

 var controller={
  id:nextControllerID,
  socket:socket,
  remoteAddress:request.connection.remoteAddress,
  isLocal:isLocal,
  lifecycle:"new",
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
  delete controller.timeout;
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
 if(typeof(message)!="object") {
  controllerError(controller,"non-JSON network message");
  return;
 }
 if(Array.isArray(message)) {
  for(var i=0;i<message.length && !controller.disconnected;++i)
  {
   if(typeof(message[i])!="object") {
    controllerError(controller,"non-JSON network message");
    return;
   }
   onInboundMessage(controller,message[i]);
  }
 }
 else {
  onInboundMessage(controller,message)
 }
}

function onInboundMessage(controller,message) {
 switch(message.k) {
  // normal flow
 case "f": onFrameMessage(controller,message); break;
 case "o": onCommandMessage(controller,message); break;
 case "l": onLoginMessage(controller,message); break;
 case "g": onGlobalChatMessage(controller,message); break;
  // API calls
 case "prelogin": onPreloginMessage(controller,message); break;
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

function onPreloginMessage(controller,message) {
 var instanceList;
 if(config.instanceDisplayList) {
  instanceList=config.instanceDisplayList;
 }
 else {
  instanceList=Object.getOwnPropertyNames(instances);
  instanceList.sort();
 }
 var defaultInstance;
 if(config.defaultInstance) {
  defaultInstance=config.defaultInstance;
 }
 else {
  defaultInstance=instanceList[0];
 }
 try {
  controller.socket.send(JSON.stringify({k:"U",n:defaultInstance,
					 l:instanceList}));
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

function onLoginMessage(controller,message) {
 if(controller.lifecycle!="new") {
  controllerError(controller,"client sent login message at inappropriate time");
  return;
 }
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
 if(message.u in inboxControllers ||
    message.u in liveControllers) {
  controllerError(controller,"you are already logged in (check other browser tabs)");
  return;
 }
  
 var instance=instances[instanceName];
 unsuspendInstance(instance);
 controller.instance=instance;
 controller.instanceName=instanceName;
 controller.playsetName=instance.playset.getName();
 controller.username=""+message.u;

 controller.socket.send(JSON.stringify({
  k:"W",
  t:getTimingPongForInstance(instance)
 }));
 
 if(controller.username in outboxControllers) {
  controller.lifecycle="inbox";
  inboxControllers[controller.username]=controller;
  // the next message is server-to-client, so the client is expected
  // to be inactive and shouldn't be timed out
  abandonConnectionTimeout(controller);
 }
 else {
  makeControllerLive(controller);
 }
}

function makeControllerLive(controller) {
 controller.lifecycle="live"
 liveControllers[controller.username]=controller;
 var instanceFrameNow=getPresentFrameNumber(controller.instance);

 controller.lastCommandNumber=0;
 controller.minFrameNumber=instanceFrameNow;
 controller.commandRateCounters={}
 
 var connectEvent={
  "c":controller.id,
  "u":controller.username,
  "f":instanceFrameNow,
  "d":users[controller.username].config,
  "k":"c",
 };
 broadcastEventToInstance(controller.instance,connectEvent,false);
 subscribeControllerToBroadcasts(controller);
 controller.globalChatTokens=config.globalChatBurstSize||
  DEFAULT_CHAT_BURST_SIZE;
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
 if(controller.lifecycle=="live") {
  controller.lifecycle="outbox"
  outboxControllers[controller.username]=controller;  
  delete liveControllers[controller.username]
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
 if(controller.id in controllers && controller.lifecycle!="outbox") {
  if(controller.lifecycle=="inbox") {
   delete inboxControllers[controller.username];
  }
  delete controllers[controller.id]
 }
 controller.disconnected=true;
}

function onFrameMessage(controller,message) {
 if(validateFrameOrCommandMessage(controller,message)) {
  var inp=""+message.i
  if(inp.length>playsetInputLengthLimits[controller.playsetName]) {
   controllerError(controller,"client sent too-large input message");
   return;
  }  
  controller.minFrameNumber=message.f+1;
  controller.lastCommandNumber=0;
  controller.commandRateCounters={}
  var event={
   "c":controller.id,
   "f":message.f,
   "k":"f",
   "i":inp
  };
  if(inp!=controller.lastFrameInput) {
   controller.lastFrameInput=inp;
   broadcastEventToInstance(controller.instance,event,true);
  }
  else {
   // always put it in the instance, and always ping back
   storeAndEchoInstanceEvent(controller.instance,event,true);
  }
  resetConnectionTimeout(controller);
 }
 // else we either errored out, or we are refusing to acknowledge an out-of-date event
}

function onCommandMessage(controller,message) {
 if(validateFrameOrCommandMessage(controller,message)) {
  var serial=message.s|0;
  if(!serial) {
   controllerError(controller,"client sent command message without serial");
   return;
  }
  var arg=(message.a||"")+""
  var playsetName=controller.playsetName;
  if(arg.length>playsetArgumentLengthLimits[playsetName]) {
   controllerError(controller,"client sent too-large command argument");
   return;
  }
  var cmd=message.o+""
  if(!(cmd in playsetCommandRateLimits[playsetName])) {
   controllerError(controller,"client sent invalid command for this playset");
   return;
  }
  if(cmd in controller.commandRateCounters &&
     controller.commandRateCounters[cmd]>=
     playsetCommandRateLimits[playsetName][cmd]) {
   controllerError(controller,"client exceeded command rate limit");
   return;
  }
  if(message.f>controller.minFrameNumber) {
   // the point of retroactive event acceptance moves forward,
   // since we won't accept an event stamped for a frame any earlier
   // than a seen command; having moved that point forward,
   // we allow command serial numbers and rate limits to reset.
   controller.minFrameNumber=message.f;
   controller.lastCommandNumber=0;
   controller.commandRateCounters={}
  }
  if(serial<=controller.lastCommandNumber) {
   controllerError(controller,"client sent out-of-order command message");
  }
  var event={
   "c":controller.id,
   "f":message.f,
   "k":"o",
   "o":cmd,
   "a":arg,
   "s":serial,
  }
  controller.lastCommandNumber=serial;
  if(cmd in controller.commandRateCounters) {
   ++controller.commandRateCounters[cmd];
  }
  else {
   controller.commandRateCounters[cmd]=1;
  }

  broadcastEventToInstance(controller.instance,event,false);
  resetConnectionTimeout(controller);
 }
 // else we either errored out, or we are refusing to acknowledge an out-of-date event
}

function validateFrameOrCommandMessage(controller,message) {
 if(controller.lifecycle!="live") {
  controllerError(controller,"game message sent without a valid login");
  return false
 }
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
  //console.log("message.f<controller.instance.pastHorizonFrameNumber");
  return false;
 }
 return true;
}

function onGlobalChatMessage(controller,message) {
 if(controller.lifecycle!="live" || !controller.globalChatTokens) {
  controllerError(controller,"client sent global chat too quickly");
  return
 }
 var m=message.m+""
 var maxChatMessageLength=config.maxChatMessageLength||
     DEFAULT_MAX_CHAT_MESSAGE_LENGTH;
 if(m.length>maxChatMessageLength) {
  controllerError(controller,
		  "client sent a global chat message that was too long");
  return;
 }
 --controller.globalChatTokens;
 broadcastMessageGlobally({
  "k":"g",
  "c":controller.id,
  "u":controller.username,
  "m":m
 })
 grantGlobalChatTokenSoon(controller);
}

function grantGlobalChatTokenSoon(controller) {
 setTimeout(
  function() {
   if(controller.lifecycle=="live") {
    ++controller.globalChatTokens;
    try {
     controller.socket.send(JSON.stringify({"k":"G"}));
    }
    catch(e) {}
   }
  },
  config.globalChatWaitMillis||DEFAULT_CHAT_WAIT_MILLIS
 );
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
 var configWanted=(message.d||"")+"";
 if(!validateUserConfigLength(configWanted,controller)) { return; }
 if(!(message.u in users &&
      doesPasswordMatchHash(message.p,users[message.u].password))) {
  controllerError(controller,"incorrect username/password");
  return;
 }
 users[message.u].config=configWanted;
 controllerDone(controller,users[message.u].config);
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

function broadcastMessageGlobally(message) {
 message=JSON.stringify(message);
 for(var k in controllers) {
  if(controllers[k].lifecycle=="live") {
   try {
    controllers[k].socket.send(message);
   }
   catch(e) {
   }   
  }
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

function storeAndEchoInstanceEvent(instance,event,addTimestamp) {
 addInstanceEvent(instance,event);
 var msg=JSON.stringify(event);
 if(event.c in instance.broadcastControllers) {
  var controller=instance.broadcastControllers[event.c];
  try {
   if(addTimestamp) {
    var injected={}
    for(var k in event) { injected[k]=event[k]; }
    injected.t=getTimingPongForInstance(instance);
    controller.socket.send(JSON.stringify(injected));
   }
   else {
    controller.socket.send(JSON.stringify(event));
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
  r:FPS,
  l:config.maxChatMessageLength||
   DEFAULT_MAX_CHAT_MESSAGE_LENGTH,
  m:controller.globalChatTokens,
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
 // unsuspended instance. submillisecond precision would be pointless
 // so flooring it to send fewer digits
 var timeZero=instance.pastHorizonPerfTime-
     (instance.pastHorizonFrameNumber*1000/FPS);
 return Math.floor(performance.now()-timeZero);
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
   commands.push({"c":events[i].c,"o":events[i].o,"a":events[i].a});
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
  var username=instance.pastHorizonControllerStatus[disconnects[i]].u;
  if(inboxControllers[username]) {
   var ctr=inboxControllers[username];
   delete inboxControllers[username];
   makeControllerLive(ctr);
  }
  var oldController= outboxControllers[username];
  delete outboxControllers[username];
  delete controllers[oldController.id];
  delete instance.pastHorizonControllerStatus[disconnects[i]];
 }
 ++instance.pastHorizonFrameNumber;

 var broadcastFrame=false
 if("frameBroadcastInterval" in config) {
  broadcastFrame=((instance.pastHorizonFrameNumber%
	      config.frameBroadcastInterval)==0);
 }
 else {
  broadcastFrame=((instance.pastHorizonFrameNumber%
	      DEFAULT_FRAME_BROADCAST_INTERVAL)==0);
 }
 
 var hashFrame=false
 if(instance.playset.hashGameState) {
  if("hashSyncInterval" in config) {
   hashFrame=(instance.pastHorizonFrameNumber%config.hashSyncInterval==0);
  }
  else {
   hashFrame=(instance.pastHorizonFrameNumber%DEFAULT_HASH_SYNC_INTERVAL==0);
  }
 }
 if(hashFrame) {
  var hash=instance.playset.hashGameState(instance.pastHorizonState);
  if(DUMP_HASH_STATES) {
   console.log("hash is "+hash+" for state:");
   console.log(instance.playset.serializeGameState(instance.pastHorizonState));
   if(instance.playset.hashGameState==defaultGameStateHash) {
    var hash2=defaultGameStateHash(JSON.parse(
     JSON.stringify(instance.pastHorizonState)));
    if(hash2!=hash) {
     console.log("but after stringify/parse, it's "+hash2);
    }
   }  
  }
  var msg=JSON.stringify({"k":"F",
			  "h":hash,
			  "f":instance.pastHorizonFrameNumber});
 }
 else if(broadcastFrame) {
  var msg=JSON.stringify({"k":"F",
			  "f":instance.pastHorizonFrameNumber});  
 }
 else {
  // base case: we don't immediately tell clients about this frame advance;
  // they'll find out next broadcastFrame or hashFrame.
  var msg=null;
 }
 

 if(msg) {
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


}

function defaultGameStateHash(o) {
 function combine(a,b) {
  return (a*65537+b*8191+127)%2147483647
 }
 function recurseContainer(container) {
  var hash=0;
  var keys=Object.getOwnPropertyNames(container); 
  keys.sort();
  // if it was an array we now have LEXICOGRAPHIC order, and also
  // "length" at the end... but that's fine! all that matters is that
  // the client and server get the same thing deterministically, and including
  // the length lets us distinguish [,,] from [,,,]
  for(var i=0;i<keys.length;++i) {
   var key=keys[i];
   hash=combine(hash,recurseString(key));
   hash=combine(hash,defaultGameStateHash(container[key]));
  }
  return combine(hash,200);
 }

 function recurseString(key) {
  var hash=0;
  for(var i=0;i<key.length;++i) {
   hash=combine(hash,key.charCodeAt(i));
  }
  return combine(hash,300);
 }

 if(Object.is(o,null)) {
  return 100;
 }
 else if(Object.is(o,undefined)) {
  return 101;
 }
 else if(Object.is(o,true)) {
  return 102;
 }
 else if(Object.is(o,false)) {
  return 103;
 }
 else if(Object.is(o,-0)) {
  // JSON serialization can and does clobber zero signs,
  // so hash needs to do likewise!
  o=0;
 }
 else if(Array.isArray(o)) {
  return combine(105,recurseContainer(o));
 }

 var t=typeof o;
 switch(t) {
 case 'number':
  return combine(106,recurseString(o.toString()));
				     
 case 'string':
  return combine(107,recurseString(o));
 case 'object':
  return combine(108,recurseContainer(o));

 default:
  // symbol, function, or host object - this object probably isn't
  // even JSON-serializable but let's return something
  return combine(109,recurseString(o.toString()));
 }
}

if(require.main==module) {
 initServer();
}


