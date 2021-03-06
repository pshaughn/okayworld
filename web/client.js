"use strict"


/* Client trusts server to be well-programmed and non-malicious, and thus
   isn't doing error-checking to the depth the server is; for example,
   if a server packet arrives at all, it is presumed necessarily a string of
   JSON, and various assumptions of server packet order exist.
   Client does not trust data structures from server to have
   correct key ordering.
   Anything another client does is mediated through the playset,
   which has to be sane on bad inputs as long as they were well-formed
   enough to get past the server.
   Server does not trust client and may disconnect it abruptly.

   Where the server has plural instances and controllers,
   the client state is just one controller connected to one instance,
   and only the playset keeps track of what other controllers mean.
 */

/* big global things */
var socket; // null when connection is closed/invalid
var clientState; // for playset to hold non-gamestate things in

/* UI things */
var keysHeldTracker, keysFreshTracker;
var screenDiv;
var smallScalingCanvas, largeScalingCanvas, largeScalingContext;

/* timing things */
var loginSentTimestamp; // for initial pong synchronization
var frameSentTimestamps; // frame number -> millis sent
var estimatedServerTimestampDifference; // in millis
var animationFrameRequestHandle;
var gameFrameTimeout;
var fps;
var lastFrameNumberDrawn; // reset to null if that frame gets invalidated

/* variables corresponding to server instance */
var pastHorizonFrameNumber; // theoretically == server's
var gameStates; // [pastHorizonFrameNumber] matches server's pastHorizonState
var controllerStatuses; // [pastHorizonFrameNumber] matches server's pastHorizonControllerStatus
var instanceEvents; // theoretically matches server's
var playset; // matches server's

/* variables for login process */
var username, password, instanceName;

/* variables corresponding to controller */
var ownControllerID;
var expectedFrameNumber; // theoretically == server's minFrameNumber
var globalChatTokens;
var maxChatMessageLength;

/* commands wait here so they can be sent on a meaningful frame number */
var outgoingCommandQueue;

/* distinguish different socket errors */
var hasSocketOpened;

var playsets={}
var commandRateLimits, argumentLengthLimit, inputLengthLimit;
var commandRateCounters;

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
 playsets[playset.getName()]=playset;
 var defaultSerialization=!("serializeGameState" in playset);
 if(!("deserializeGameState" in playset)) {
  playset.deserializeGameState=function(str) {
   return JSON.parse(str);
  }
 }
 else {
  defaultSerialization=false;
 }
 if(!("copyGameState" in playset)) {
  if("serializeGameState" in playset) {
   playset.copyGameState=function(state) {
    return this.deserializeGameState(this.serializeGameState(state));
   }
  }
  else {
   playset.copyGameState=function(state) {
    return this.deserializeGameState(JSON.stringify(state));
   }
  }
 }
 if(defaultSerialization && !("hashGameState" in playset)) {
  playset.hashGameState=defaultGameStateHash;
 }
 if(!("handleClientPrediction" in playset)) {
  playset.handleClientPrediction=function() {}
 }
 if(!("handleClientConfirmation" in playset)) {
  playset.handleClientConfirmation=function() {}
 }
 if(!("advanceGameState" in playset)) {
  playset.advanceGameState=defaultPlaysetAdvanceGameState
 }
}

function getPlayset(name) {
 return playsets[name];
}

function onLoginClick() {
 if(!socket) {
  username=document.getElementById("usernameInput").value;
  password=document.getElementById("passwordInput").value;
  instanceName=document.getElementById("instanceInput").value;
  socket=new WebSocket(OKAY_SOCKET_SERVER_URL);
  hasSocketOpened=false;
  socket.addEventListener("open",onSocketOpen);
  socket.addEventListener("error",onSocketError);
  socket.addEventListener("close",onSocketClose);
 }
 document.getElementById("loginUI").style.display="none";
 document.getElementById("waitUI").style.display="block";
}


function onSocketOpen() {
 hasSocketOpened=true;
 socket.addEventListener("message",onSocketMessage);

 try {
  socket.send(JSON.stringify({
   k:'l',
   u:username,
   p:password,
   n:instanceName
  }));
 }
 catch(e) {
  console.error("error in initial send",e);
  // if that failed, we have a socket error or close event coming up.
 }
 loginSentTimestamp=performance.now();
}

function onSocketMessage(e) {
 var message=JSON.parse(e.data);
 switch(message.k) {
 case "E":
  onErrorMessage(message);
  break;
 case "W":
  onInitialPingResponseMessage(message);
  break;
 case "S":
  onInitialStateMessage(message);
  break;
 case "F":
  onFrameAdvanceMessage(message);
  break;
 case "c": // if we're in this function, this must be a different controller's
  onClientMessage(message);
  break;
 case "o": // could be ack of own, or could be someone else's
  if(message.c==ownControllerID) {
   acceptAck(message);
  }
  else {
   onClientMessage(message);
  }
  break;
 case "f": // could be ack of own, or could be someone else's 
  if(message.c==ownControllerID) {
   handlePong(frameSentTimestamps[message.f],message.t)
   acceptAck(message);
  }
  else {
   onClientMessage(message);
  }
  break;
 case "d": // this must be a different controller's
  onClientMessage(message);
  break;
 case "g":
  onGlobalChatMessage(message);
  break;
 case "G":
  onGlobalChatTokenMessage(message);
  break;
  // don't worry about default, assumption is a non-farting server
 }
}

function handleConnectionEnd() {
 if(playset) {
  playset.destroyUI();
  screenDiv.innerHTML="";
 }
 if(animationFrameRequestHandle) {
  cancelAnimationFrame(animationFrameRequestHandle);
  animationFrameRequestHandle=null;
 }
 if(gameFrameTimeout) {
  clearTimeout(gameFrameTimeout);
  gameFrameTimeout=null;
 }
 try {
  socket.close();
 }
 catch(e) { /* was probably already closed */ }
 socket=null;
 document.getElementById("waitUI").style.display="none";
 document.getElementById("gameUI").style.display="none";
 document.getElementById("loginUI").style.display="block";
}

function onSocketError() {
 if(socket) {
  handleConnectionEnd();
  if(hasSocketOpened) {
   showDisconnectReason("Connection error");
  }
  else {
   showDisconnectReason("Connection error (server may be down)");
  }
 }
}

function onSocketClose() {
 if(socket) {
  handleConnectionEnd();
  showDisconnectReason("Connection closed");
 }
}

function onInitialPingResponseMessage(message) {
 handlePong(loginSentTimestamp,message.t);
}

function onInitialStateMessage(message) {
 frameSentTimestamps={}

 clientState={}
 playset=getPlayset(message.p);
 inputLengthLimit=("getInputLengthLimit" in playset)?
  playset.getInputLengthLimit():Infinity;
 argumentLengthLimit=("getArgumentLengthLimit" in playset)?
  playset.getArgumentLengthLimit():Infinity;
 commandRateLimits=("getCommandLimits" in playset)?
  playset.getCommandLimits():Infinity;
 fps=message.r;
 pastHorizonFrameNumber=message.f;
 gameStates={}
 gameStates[pastHorizonFrameNumber]=playset.deserializeGameState(message.g);
 controllerStatuses={}
 controllerStatuses[pastHorizonFrameNumber]=message.x;
 ownControllerID=message.c;
 globalChatTokens=message.m;
 maxChatMessageLength=message.l;
 instanceEvents={};
 outgoingCommandQueue=[];
 commandRateCounters={};
 //console.log(message)
 for(var i in message.e) {
  var submessage=message.e[i];
  switch(submessage.k) {
  case "c": // possibly ours, and if so it tells us which frame is expected
   if(submessage.c == ownControllerID) 
   {
    expectedFrameNumber=submessage.f;
   }
   // whether or not it's ours, it needs to go in the event list.
   onClientMessage(submessage);
   break;
  case "o": // from here, this is another controller's
   onClientMessage(submessage);
   break;
  case "f": //  from here, this is another controller's
   onClientMessage(submessage);
   break;
  case "d": // this must be a different controller's
   onClientMessage(submessage);
   break;
  }
 }
 // state is set up 
 document.getElementById("waitUI").style.display="none";
 document.getElementById("gameUI").style.display="block";
 screenDiv=document.getElementById("mainGameUI");
 screenDiv.innerHTML="";
 if(!keysHeldTracker) {
  window.addEventListener('keydown',onKeydown)
  window.addEventListener('keyup',onKeyup)
  window.addEventListener('blur',onBlur)
 }
 keysHeldTracker={}
 keysFreshTracker={}

 initChat();
 if(globalChatTokens) { enableChatInput(); }
 
 var frame=estimatePresentTimeFrameNumber();
 var state=getEstimatedGameState(frame);
 playset.initUI(state);
 playset.handleClientConfirmation(gameStates[pastHorizonFrameNumber],
				  pastHorizonFrameNumber);
 playset.handleClientPrediction(gameStates[pastHorizonFrameNumber],
				pastHorizonFrameNumber);
 lastFrameNumberDrawn=frame;
 gameFrameTimeout=setTimeout(onGameFrameTimeout,0);
 animationFrameRequestHandle=requestAnimationFrame(onAnimationFrame);


}

function onKeydown(e) {
 if(document.activeElement.tagName=="INPUT") {
  if(document.activeElement.id=="chatInput" &&
     e.code=="Enter" || e.code=="NumpadEnter") {
   onChatSendClick();
  }
 }
 else {
  if(!keysHeldTracker[e.code]) {
   keysHeldTracker[e.code]=true;
   keysFreshTracker[e.code]=true; 
  }
  if(!e.shiftKey && !e.ctrlKey) {
   e.preventDefault();
  }
 }
}

function onKeyup(e) {
 if(keysHeldTracker[e.code]) {
  delete keysHeldTracker[e.code];
 }
 if(!e.shiftKey && !e.ctrlKey) {
  e.preventDefault();
 }
}

function onBlur(e) {
 keysHeldTracker={}
}


function handlePong(sent,serverReceipt) {
 // assume the time when this hit the server is halfway between
 // the time it was sent and now, calculate the client-side
 // timestamp at that point.
 var estimatedClientReceipt=(performance.now()+sent)/2
 // no smoothing for now, maybe try smoothing later
 estimatedServerTimestampDifference=serverReceipt-estimatedClientReceipt;
}

function onErrorMessage(message) {
 if(socket) {
  handleConnectionEnd();
  showDisconnectReason(message.e);
 }
}

function onFrameAdvanceMessage(message) {
 //console.log(pastHorizonFrameNumber,estimatePresentTimeFrameNumber(),message);
 while(pastHorizonFrameNumber<message.f) {
  advanceHorizonState();
 }
 if("h" in message) {
  var hash=playset.hashGameState(gameStates[pastHorizonFrameNumber]);
  if(message.h!=hash) {
   handleConnectionEnd();
   showDisconnectReason("Desynchronized from server game state. Try shift-reloading. If the problem persists, there may be a bug in the game logic.");
  }
  else {
    //console.log("Passed hash",hash);
  }
 }
}

function onClientMessage(message) {
 if(message.f in instanceEvents) {
  instanceEvents[message.f].push(message);
 }
 else {
  instanceEvents[message.f]=[message];
 }
 // invalidation happens if this is a connect, quit, or command,
 // or if it's a frame with an input state that differs from the
 // already-predicted input state of its frame number
 if((message.f+1) in gameStates &&
    (message.k=='c' || message.k=='o' || message.k=='d' ||
     (message.k=='f' && message.i!=controllerStatuses[message.f]))) {
  var toInvalidate=message.f+1;
  while(toInvalidate in gameStates) {
   if(toInvalidate == lastFrameNumberDrawn) {
    lastFrameNumberDrawn=null;
   }
   delete gameStates[toInvalidate];
   delete controllerStatuses[toInvalidate];
   ++toInvalidate;
  }
 }
}

function advanceHorizonState() {
 // we can forget timestamp...
 if(pastHorizonFrameNumber in frameSentTimestamps) {
  delete frameSentTimestamps[pastHorizonFrameNumber];
 }

 // if anything is unacked on the horizon frame, delist it
 // and invalidate subsequent states
 if(pastHorizonFrameNumber in instanceEvents) {
  pruneUnackedEvents();
 }

 computeGameStateGivenPrevious(pastHorizonFrameNumber+1);
 delete gameStates[pastHorizonFrameNumber];
 delete controllerStatuses[pastHorizonFrameNumber];
 if(pastHorizonFrameNumber in instanceEvents) {
  delete instanceEvents[pastHorizonFrameNumber];
 }
 ++pastHorizonFrameNumber;
 playset.handleClientConfirmation(gameStates[pastHorizonFrameNumber],
				  pastHorizonFrameNumber);
 
}

function pruneUnackedEvents() {
 var mustInvalidate=false;
 var pastHorizonStatuses=controllerStatuses[pastHorizonFrameNumber];
 if(ownControllerID in pastHorizonStatuses) {
  var myOldControllerInput=pastHorizonStatuses[ownControllerID];
     
  var filteredEvents=instanceEvents[pastHorizonFrameNumber].filter(
   function(e) {
    if(e.unacked) {
     // invalidate if any command is unacked, or if the input frame
     // is unacked and includes an input change.
     if(e.k=='o' ||
	e.i!=myOldControllerInput) {
      mustInvalidate=true;
     }
     //console.log("removing unacked event",e);
     return false;
    }
    return true;
   }
  )
  instanceEvents[pastHorizonFrameNumber]=filteredEvents;
 }
 else {
  mustInvalidate=true;
 }
  

 if(mustInvalidate) {
  //console.log("invalidating due to unacked event");
  if(lastFrameNumberDrawn!=pastHorizonFrameNumber) {
   lastFrameNumberDrawn=null;
  }
  var keepState=gameStates[pastHorizonFrameNumber];
  var keepController=controllerStatuses[pastHorizonFrameNumber];
  gameStates={}
  gameStates[pastHorizonFrameNumber]=keepState;
  controllerStatuses={}
  controllerStatuses[pastHorizonFrameNumber]=keepController;
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

function computeGameStateGivenPrevious(newFrameNumber) {
 // almost a cutpaste of server's advanceHorizonState,
 // but with frame number awareness and no forgetting the past.
 // after this, controllerStatuses[newFrameNumber] and
 // gameStates[newFrameNumber] should be good to go.

 var events=instanceEvents[newFrameNumber-1] || [];

 var connects=[];
 var commands=[];
 var inputs=[];
 var disconnects=[];
 events.sort(instanceEventComparator);

 var newControllerStatus={}
 var oldControllerStatus=controllerStatuses[newFrameNumber-1];
 //var carriedStatus=false;
 for(var k in oldControllerStatus) {
  newControllerStatus[k]={u:oldControllerStatus[k].u,
			  i:oldControllerStatus[k].i};
  //carriedStatus=true;
 }
 //if(!carriedStatus) {
 // console.log("carried no status",newFrameNumber,instanceEvents);
 //}
 controllerStatuses[newFrameNumber]=newControllerStatus

 //console.log(controllerStatuses)
 
 for(var i in events) {
  switch(events[i].k) {
  case "c":
   newControllerStatus[events[i].c]={u:events[i].u,i:""};
   connects.push({"c":events[i].c,"u":events[i].u,"d":events[i].d});
   break;
  case "o":
   commands.push({"c":events[i].c,"o":events[i].o});
   break;
  case "f":
   newControllerStatus[events[i].c].i=events[i].i;
   break;
  case "d":
   disconnects.push(events[i].c);
   break;
  default:
   console.warn("saw a strange event",events[i]);
   break;
  }
 }
 var controllersConnected=Object.getOwnPropertyNames(newControllerStatus);
 controllersConnected.sort(integerComparator);
 for(var i in controllersConnected) {
  var c=controllersConnected[i];
  inputs.push({"c":c,"i":newControllerStatus[c].i});  
 }
 var newState=playset.copyGameState(gameStates[newFrameNumber-1]);
 playset.advanceGameState(newState,
			  connects,commands,inputs,disconnects);
 gameStates[newFrameNumber]=newState;
 for(var i in disconnects) {
  delete newControllerStatus[disconnects[i]];
 }
}

function getEstimatedGameState(n) {
 if(n<pastHorizonFrameNumber) { return null; }
 if(gameStates[n]) { return gameStates[n]; }
 var toEstimate=n;
 while(!gameStates[toEstimate-1]) { --toEstimate; }
 while(toEstimate<=n) {
  computeGameStateGivenPrevious(toEstimate);
  ++toEstimate;
 }
 return gameStates[n];
}

function estimatePresentTimeFrameNumber() {
 var milli=performance.now()+estimatedServerTimestampDifference;
 var frame=Math.floor(milli*fps/1000);
 if(frame<pastHorizonFrameNumber) { return pastHorizonFrameNumber; }
 return frame;
}

function onAnimationFrame() {
 var frame=estimatePresentTimeFrameNumber();
 var state=getEstimatedGameState(frame);
 if(frame!=lastFrameNumberDrawn) {
  playset.refreshUI(state,frame);
  refreshScalingCanvas()
  lastFrameNumberDrawn=frame;
 }
 animationFrameRequestHandle=requestAnimationFrame(onAnimationFrame);
}

function onGameFrameTimeout() {
 var frame=estimatePresentTimeFrameNumber();
 // may need to skip over frames
 while(expectedFrameNumber<frame) {
  var state=getEstimatedGameState(expectedFrameNumber);
  playset.handleClientPrediction(state,frame);
  ++expectedFrameNumber;
 }
 // done skips, now to handle the current frame

 // getting input BEFORE processing outgoingCommandQueue, since
 // the input-poller might push commands
 var inp=playset.getCurrentInputString();
 if(inp.length>inputLengthLimit) {
  inp=inp.slice(0,inputLengthLimit);
 }
 var messageList=[]
 if(expectedFrameNumber==frame) {
  for(var i in outgoingCommandQueue) {
   var message={'k':'o',
		'o':outgoingCommandQueue[i].o,
		'a':outgoingCommandQueue[i].a,
		'f':expectedFrameNumber,
		's':i+1};
   messageList.push(message);
  }
  outgoingCommandQueue=[]

  var message={'k':'f',
	       'f':expectedFrameNumber,
	       'i':inp};
  messageList.push(message);
  frameSentTimestamps[expectedFrameNumber]=performance.now();

  // worst case scenario is hitting the rate cap on every allowed command,
  // with long arguments, and sending a long input string. if that
  // ever threatens to get close to 20000 bytes when stringified to JSON,
  // something will need to be done about it.
  try { socket.send(JSON.stringify(messageList)); } catch(e) {}
  for(var i in messageList) {
   messageList[i].c=ownControllerID;
   messageList[i].unacked=true;
   onClientMessage(messageList[i]);
  }

  var state=getEstimatedGameState(expectedFrameNumber);
  playset.handleClientPrediction(state,expectedFrameNumber);
  ++expectedFrameNumber;
  commandRateCounters={}
  keysFreshTracker={}
 }

 var milliNow=performance.now()+estimatedServerTimestampDifference; 
 var milliWanted=(expectedFrameNumber*1000/fps);
 var wait=milliWanted-milliNow;
 if(wait<0) {
  wait=0;
 }
 if(wait>1000/fps) {
  wait=1000/fps;
 }
 gameFrameTimeout=setTimeout(onGameFrameTimeout,wait);
}

function acceptAck(message) {
 var events=instanceEvents[message.f];
 for(var i=0;i<events.length;++i) {
  if(events[i].unacked &&
     events[i].c==message.c &&
     events[i].k==message.k &&
     (message.k=='f' || message.s==events[i].s)) {
   delete events[i].unacked;
  }
 }
}

function initChat() {
 var box=document.getElementById("chatScrollBox");
 box.textContent=""
 document.getElementById("chatInput").value="";
 document.getElementById("chatSendButton").disabled=true;
 document.getElementById("chatSendButton").onclick=onChatSendClick;
 document.getElementById("chatInput").oninput=onChatInputEvent;
}

function onChatSendClick() {
 var b=document.getElementById("chatSendButton");
 if(!b.disabled) {
  var text=document.getElementById("chatInput").value.trim();
  document.getElementById("chatInput").value="";
  if(text && text.length<=maxChatMessageLength) {
   sendChatMessage(text);
  }
 }
}

function onChatInputEvent() {
 if(this.value.length>maxChatMessageLength) {
  document.getElementById("chatSendButton").disabled=true
 }
 else if(globalChatTokens>0) {
  document.getElementById("chatSendButton").disabled=false
 }
}

function sendChatMessage(text) {
 // for now the only channel is global
 try {
  socket.send( JSON.stringify({k:"g",m:text}))
  --globalChatTokens;
  console.log(globalChatTokens);
  if(globalChatTokens<=0) {
   disableChatInput();
  }
 }
 catch(e) {}
}

function onGlobalChatMessage(m) {
 var box=document.getElementById("chatScrollBox");
 var nearBottom=(box.scrollTop+box.clientHeight>=box.scrollHeight-16);
 var d=document.createElement("div");
 d.className="chatLine";
 // TODO: username coloring?
 var head=document.createElement("span");
 head.textContent=m.u;
 head.className="chatUsername";
 var body=document.createElement("span");
 body.textContent=m.m;
 body.className="chatText";
 d.appendChild(head);
 d.appendChild(body);
 box.appendChild(d)
 
 // if scrolled to bottom before new line, stay scrolled to bottom
 if(nearBottom) {
  box.scrollTop=box.scrollHeight;
 }
}

function onGlobalChatTokenMessage() {
 ++globalChatTokens;
 if(globalChatTokens==1) {
  enableChatInput();
 }
}

function enableChatInput() {
 document.getElementById("chatSendButton").disabled=false;
}

function disableChatInput() {
 document.getElementById("chatSendButton").disabled=true;
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

function isKeyHeld(code) {
 return !!keysHeldTracker[code]
}

function isKeyFresh(code) {
 return !!keysFreshTracker[code]
}

function getOwnControllerID() {
 return ownControllerID;
}

function sendGameCommand(commandString,argString) {
 if(commandString in commandRateLimits &&
    (!(commandString in commandRateCounters) ||
     commandRateCounters[commandString]<commandRateLimits[commandString]))
 {
  argString=(argString||"")+""
  if(argString.length>argumentLengthLimit) {
   argString=argString.slice(0,argumentLengthLimit);
  }
  if(commandString in commandRateCounters) {
   commandRateCounters[commandString]+=1
  }
  else {
   commandRateCounters[commandString]=1;
  }
  outgoingCommandQueue.push({o:commandString,a:argString});
 }
}

function showDisconnectReason(reason) {
 document.getElementById("errorDiv").innerText="Disconnected: "+reason;
 document.getElementById("errorDiv").style.display="block";
}

function showPreloginWait() {
 document.getElementById("preloginUI").innerText="Checking connection to server...";
}

function showPreloginFail(message) {
 if(!message) {
  var text="The game server appears to be down (or possibly your network connection to it is down). Try again later."
 }
 else {
  var text="Server returned an error: "+message
 }
 document.getElementById("preloginUI").innerText=text
}

function showPreloginSuccess(message) {
 var select=document.getElementById("instanceInput");
 select.innerHTML="";
 for(var i in message.l) {
  var name=message.l[i]
  var option=document.createElement("option");
  option.value=name
  option.innerText=name
  if(name==message.n) { option.selected=true; }
  select.appendChild(option);
 }
 document.getElementById("preloginUI").style.display="none"
 document.getElementById("loginUI").style.display="block"
}



function onInitialLoad() {
 window.removeEventListener("load",onInitialLoad);
 showPreloginWait();
 var done=false;
 try {
  var socket=new WebSocket(OKAY_SOCKET_SERVER_URL);
  socket.addEventListener("error",function() {
   if(!done) {
    done=true;
    showPreloginFail();
   }
  })
  socket.addEventListener("open", function() {
   socket.send(JSON.stringify({
    "k":"prelogin"
   }));
   this.addEventListener("close",function() {
    if(!done) {
     done=true;
     showPreloginFail();
    }
   })
   this.addEventListener("message",function(e) {
    // we can assume this is a prelogin success
    var message=JSON.parse(e.data);
    if(message.k=="E") {
     showPreloginFail(message.e);
    }
    else {
     showPreloginSuccess(message);
    }
    done=true;
   });
  });
 }
 catch(e) {
  if(!done) {
   console.error(e);
   showPreloginFail();
  }
 } 
}

function createScalingCanvas(smallCanvas) {
 if(largeScalingCanvas && largeScalingCanvas.parentElement) {
  largeScalingCanvas.parentElement.removeChild(largeScalingCanvas);
 }
 smallScalingCanvas=smallCanvas;
 largeScalingCanvas=document.createElement("canvas");
 largeScalingContext=largeScalingCanvas.getContext("2d");
 largeScalingCanvas.style.position="absolute";
 largeScalingCanvas.style.left="50%";
 largeScalingCanvas.style.top="50%";
 screenDiv.appendChild(largeScalingCanvas);
 refreshScalingCanvas(true);
 return largeScalingCanvas;
}

function refreshScalingCanvas(forceSize) {
 if(largeScalingCanvas && largeScalingCanvas.parentElement) {
  var bcr=screenDiv.getBoundingClientRect();
  var widths=Math.max(1,Math.floor(bcr.width/smallScalingCanvas.width));
  var heights=Math.max(1,Math.floor(bcr.height/smallScalingCanvas.height));
  var scale=Math.min(widths,heights);
  if(forceSize || largeScalingCanvas.width!=scale*smallScalingCanvas.width ||
     largeScalingCanvas.height!=scale*smallScalingCanvas.height) {
   largeScalingCanvas.width=smallScalingCanvas.width*scale;
   largeScalingCanvas.height=smallScalingCanvas.height*scale;   
   largeScalingCanvas.style["margin-left"]=-(largeScalingCanvas.width/2)+"px"
   largeScalingCanvas.style["margin-top"]=-(largeScalingCanvas.height/2)+"px"
   largeScalingContext.imageSmoothingEnabled=false;
  }
  largeScalingContext.drawImage(smallScalingCanvas,
				0,0,
				smallScalingCanvas.width,
				smallScalingCanvas.height,
				0,0,
				largeScalingCanvas.width,
				largeScalingCanvas.height);
 }
}

window.addEventListener("load",onInitialLoad);

