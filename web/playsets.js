"use strict"

/**
   This file is special: node and browser both execute it, meaning its
   concept of the global namespace is a bit underspecified.
   A playset is an object that you pass to registerPlayset(), a global
   function which is defined slightly differently between server and client.
   A playset needs to hold only methods and static data, not dynamic data.
   Anything dynamic goes in the game state or the browser client, not the 
   playset.
   All playset operations need to be synchronous and not start anything
   that isn't.

   The meat of a playset's game logic must be in one of these two forms:
   (1) a single monolothic game-logic-running function
    .advanceGameState(gameState, connects, commands, inputs, disconnects):
      -- gameState is a game state
      -- connects is a list of {c:controllerID, u:username, d:userConfigString}
      -- commands is a list of {c:controllerID, o:commandString, a:argString}
      -- inputs is a list of {c:controllerID, i:inputString}
      -- disconnects is a list of controller IDs
      mutate game state by applying these and one frame's worth of game logic,
      without referencing anything dynamic or doing anything nondeterministic.
      unexpected input strings, arg strings, and user config strings must be 
      tolerated in a way that doesn't introduce any nondeterminism. unexpected
      command strings will not happen, and controller IDs will only be seen
      from their connect frame to their disconnect frame inclusive.
   (2) several smaller functions.
    .applyConnect(gameState,controllerID,username,userConfigString):
     required, mutate game state to account for the connect
    .applyCommand(gameState,controllerID,commandString,argString):
     optional, mutate game state to account for the command
    .applyControllerFrame(gameState,controllerID,inputString,commandList):
     required, mutate game state to account for the input for 1 frame. 
     commandList will contain 0 or more {o:commandString,a:argString} objects. 
     This will be called on every frame from a controller's connect to its 
     disconnect, inclusive. Logic for the "player sprite" can go here, or it 
     can just queue up the input for .applyStateFrame to handle it
    .applyStateFrame(gameState):
     optional, mutate game state for 1 frame of time elapsing
    .applyDisconnect(gameState,controllerID):
     required, mutate game state to account for the disconnect
    These are called in a strict order: all connects, then all commands,
     then all controller frames, then state frame, then all disconnects.
     This implies all connects and commands can rely on the existence of a
     subsequent controller frame and all controller frames can rely on
     a subsequent applyStateFrame (if defined). This entire batch of calls
     is a single atomic operation as far as network and UI code is concerned;
     refreshUI, serializeGameState, et al won't be called until the end of the
     frame's batch and don't have to be tolerant of intermediate states.
    
   Playsets must also have:
    .getName(): return constant string different from any other playset name
    .getCurrentInputString(): called only by client, encode current user inputs
                              (not necessarily every frame, but never more than
			      once per frame)
    .initUI(gameState): called only by client
    .refreshUI(gameState,frameNumber): called only by client, 
     not necessarily every frame, possibly more than once for the same frame,
     possibly out of order
    .destroyUI(): called only by client, if connection drops


    Playsets with non-JSON-serializable game states must have:
    .deserializeGameState(str): convert string to a game state
    .serializeGameState(gameState): convert game state to string
    
    Playsets may have:
   .getCommandLimits(): return an object where keys are valid command
                        strings, and values are how many of that
			command can be issued by one controller in a frame. if
			absent, command events won't happen at all.
   .getInputLengthLimit(): return a number for the maximum input string length;
                           if absent, no limiting is applied other than the
			   maximum network message size
   .getArgumentLengthLimit(): return a number for the maximum command
                              argument string length; if absent, commands
			      can only send length-0 argument strings.
   .copyGameState(gameState): return a deep copy of the game state
                              [default serializes and deserializes]
   .handleClientPrediction(gameState,frameNumber): called only by client, 
     definitely at least once per frame, possibly more than once, possibly out
     of order. Intended use case: fire sound effects that it's okay to be 
     wrong about (try to keep track of which frames a sound's already fired
     for since this can be called multiple times on the same frame)
     Do not mutate state! [default is a no-op]
   .handleClientConfirmation(gameState,frameNumber): called only by client,
     for every frame, some time after the frame has already happened when
     it is known that there will be no further retroactive events for it.
     Intended use cases: major UI state transitions, sound effects that
     it's not okay to be wrong about but is okay to delay, clearing out
     tracked data from old handleClientPrediction calls
     Once per frame, in order. Do not mutate state! [default is a no-op]
   .hashGameState(gameState): return a number or string that will be
     equal on equal game states. If this is absent and deserializeGameState
     and serializedGameState were both left default, this will also take a
     default. If that creates spurious hash mismatches but you don't want
     to define your own hash function, you can just set hashGameState to
     null and the playset won't try to hash-sync.
			      
   Client-only methods may access and mutate the DOM. Additionally,
   they can call support functions that are defined in the client, including:

   sendGameCommand(commandString [,argString]): issue a command event 
    (next time a frame is sent; if rate limits block it it will be dropped
    entirely, not delayed) Sending a game command as a side effect during 
    getCurrentInputString is allowed, as is sending one from a DOM event 
    that was set up by initUI or refreshUI.    
   isKeyHeld(code): boolean
   isKeyFresh(code): boolean, true if there's a positive-edge since last
                     getCurrentInputString 
   getOwnControllerId(): returns controller ID of local player
   createScalingCanvas(smallCanvas): returns a canvas that's centered in
                                     screenDiv and tracks the given canvas
				     at a pixel size multiple. calling
				     it again abandons the old one. the return
				     value can be ignored but might be
				     useful for attaching mouse event handlers
   


   clientState is an otherwise-empty object in the client's global namespace,
   made available so client-only methods can avoid having to put things in the
   global namespace (e.g. handles to DOM elements they create)

   screenDiv is a DOM element in the client's global namespace that's a div 
   to put the game UI in; it's empty going into initUI

   Playsets may have utility functions; playset methods will always be called 
   with "this" as the playset. Playsets may also have fields, but use them
   only as constants or as very carefully-managed caches!
   
   To help with determinism, "M" is defined in this module to hold various
   static math functions that work on integers.

   The main difference between commands and input strings is that,
   if a user misses frames due to lag or their local cpu load, their last 
   input string will be repeated over the missed frames, while commands 
   will be delayed to happen on just the next non-missing one, not multiplied.
   For example, if positive-edge and negative-edge UI events matter, then those
   events should be explicit commands or implicit in input string changes,
   not explicitly part of the input string. Command arguments can provide the
   "noun" for a command's "verb", such as mouse click coordinates.

   playset signature summary:
    getName()=>static string

    [basic game logic]
    applyConnect(mutable state,connectionID,username,profileString)
    applyControllerFrame(mutable state,connectionID,inputString,commands)
     in which commands is an array of 0+ {o:commandString, a:argumentString}
    applyStateFrame(mutable state)
    applyDisconnect(mutable state, connectionID)

    [alternate, monolithic-function game logic]
    advanceGameState(mutable state,connects,commands,inputs,disconnectIDs)

    [used on client only]
    getCurrentInputString()=>dynamic string
    initUI(state) updates client DOM
    refreshUI(state) updates client DOM
    destroyUI(state) updates client DOM

    [client only, not required]
    handleClientPrediction(state.frameNumber) updates client DOM
    handleClientConfirmation(state,frameNumber) updates client DOM

    [if using commands]
    getCommandLimits()=>static object from command strings to numbers

    [if using commands and not handling them in applyControllerFrame]
    applyCommandFrame(mutable state, commandString, argumentString)

    [if game states aren't JSON-compatible]
    serializeGameState(state)=>string
    deserializeGameState(string)=>state
    copyGameState(state)=>state

    [not required, but help server protect against malicious clients]
    getInputLengthLimit()=>static number
    getArgumentLengthLimit()=>static number

    [not required, but helps client detect playset bugs]
    hashGameState(state)=>number or string

    
   });



   M operations:
   M.trunc(n): rounds toward 0
   M.floorsqrt(n): just floor(sqrt(floor(n)))   
   M.mod(a,b): like a%b but never negative
   M.sin256(degrees): approximation of sin(degrees)*256
   M.cos256(degrees): approximation of cos(degrees)*256
   M.forEachAscending(collection,function(element,index),thisArg):
    like forEach with deterministic key ordering
   M.sortNumerically(array): like array.sort() but numbers and numeric strings
    will be compared numerically (not every possible special case is handled;
    intended use case is to sort the output of Object.getOwnPropertyNames)
    
*/

const M={
 SINE_TABLE:[
  0,4,9,13,18,22,27,31,36,40,44,49,53,58,62,
  66,71,75,79,83,88,92,96,100,104,108,112,116,120,124,128,
  132,136,139,143,147,150,154,158,161,165,168,171,175,178,181,
  184,187,190,193,196,199,202,204,207,210,212,215,217,219,222,
  224,226,228,230,232,234,236,237,239,241,242,243,245,246,247,
  248,249,250,251,252,253,254,254,255,255,255,256,256,256,256,
  256],
 trunc:function(n) {
  if(n>0) { return Math.floor(n); }
  else { return Math.ceil(n); }
 },
 floorsqrt:function(n) {
  return Math.floor(Math.sqrt(Math.floor(n)));
 },
 mod:function(a,b) {
  var result=a%Math.abs(b);
  if(result<0) { return result+Math.abs(b); }
  return result;
 },
 sin256:function(degrees) {
  degrees=M.mod(M.trunc(degrees),360);
  if(degrees<=90) { return M.SINE_TABLE[degrees]; }
  else if(degrees<=180) { return M.SINE_TABLE[180-degrees]; }
  else if(degrees<=270) { return -M.SINE_TABLE[degrees-180]; }
  else { return -M.SINE_TABLE[360-degrees]; }
 },
 cos256:function(degrees) {
  return M.sin256(degrees+90);
 },
 forEachAscending:function(collection,thunk,thisArg) {
  if(collection.isArray) {
   forEach(collection,thunk,thisArg);
  }
  else {
   var names=Object.getOwnPropertyNames(collection);
   M.sortNumerically(names);
   for(var i=0;i<names.length;++i) {
    var name=names[i];
    if(name in collection) {
     thunk.call(thisArg,collection[name],name);
    }
   }   
  }
 },
 sortNumerically:function(list) {
  list.sort(function(a,b) {
   if(+a<+b) { return -1; }
   if(+b<+a) { return 1; }
   if(a<b) { return -1; }
   if(b<a) { return 1; }
   if(a+""<b+"") { return -1; }
   if(b+""<a+"") { return 1; }
   return 0;
  });
 }
}

registerPlayset({
 RNG_MODULUS:Math.pow(2,31)-1,
 getCommandLimits:function() {
  return {'f':1}
 },
 getName:function() { return "spaceduel" },
 rand:function(state,n) {
  state.prng=((state.prng||1)*16807)%this.RNG_MODULUS
  return state.prng%n;
 },

 respawnShip:function(state,ship) {
  var x=this.rand(state,160*256)+80*256;
  var y=this.rand(state,160*256)+40*256;
  var theta=this.rand(state,360);
  ship.x=x;
  ship.y=y;
  ship.theta=theta;
  ship.invincFrames=60;
  ship.shotTimeout=60;
  ship.xv=0;
  ship.yv=0;
 },
 
 applyConnect:function(state,controllerID,username,profile) {
  var x=this.rand(state,160*256)+80*256;
  var y=this.rand(state,160*256)+40*256;
  var theta=this.rand(state,360);
  var s={
   controller:controllerID,
   username:username,
   profile:profile,
  };
  this.respawnShip(state,s);
  state.ships[controllerID]=s;
 },
 applyControllerFrame:function(state,controllerID,input,commands) {
  var ship=state.ships[controllerID];
  if(input.indexOf("l")!=-1) { ship.theta-=3; }
  if(input.indexOf("r")!=-1) { ship.theta+=3; }
  ship.theta=M.mod(ship.theta,360);
  if(input.indexOf("u")!=-1) {
   ship.xv+=M.trunc(M.cos256(ship.theta)/2);
   ship.yv+=M.trunc(M.sin256(ship.theta)/2);
  }
  ship.xv=M.trunc(ship.xv*127/128);
  ship.yv=M.trunc(ship.yv*127/128);
  var v2=ship.xv*ship.xv+ship.yv*ship.yv;
  if(v2>1024*1024) {
   var v=M.floorsqrt(v2);
   ship.xv=M.trunc(ship.xv*1024/v);
   ship.yv=M.trunc(ship.yv*1024/v);
  }
  ship.x+=ship.xv;
  ship.y+=ship.yv;
  if(ship.invincFrames) { --ship.invincFrames; }
  if(ship.shotTimeout) { --ship.shotTimeout; }
  if(ship.shotTimeout==0 && commands.length>0) {
   state.shots.push({
    x:ship.x,
    y:ship.y,
    xv:M.cos256(ship.theta)*6+ship.xv,
    yv:M.sin256(ship.theta)*6+ship.yv,
    controller:controllerID
   });
   ship.shotTimeout=10;
  }
  if(ship.x<0 || ship.y<0 ||
      ship.x>640*256 || ship.y>480*256) {
   this.respawnShip(state,ship);
  }
 },
 applyStateFrame:function(state) {
  this.rand(state);
  var ships=state.ships
  var shots=state.shots
  for(var i in ships) {
   var c=ships[i].controller;
  }
  var self=this;
  for(var i in shots) {
   shots[i].x+=shots[i].xv;
   shots[i].y+=shots[i].yv;
   M.forEachAscending(ships,function(ship) {
    if(ship.controller != shots[i].controller &&
       ship.invincFrames==0 && !shots[i].done) {
     var dx=ship.x-shots[i].x;
     var dy=ship.y-shots[i].y;
     if(dx*dx+dy*dy<(10*256)*(10*256)) {
      this.respawnShip(state,ship);
      shots[i].done=true
     }     
    }
   },this);
   
   state.shots=shots.filter(function(s) {
    return s.x>0 && s.x<320*256 && s.y>0 && s.y<240*256 && !s.done;
   })
  }
 },
 applyDisconnect:function(state,controllerID) {
  delete state.ships[controllerID];
 },
 initUI:function(state) {
  var canvas=document.createElement("canvas");
  canvas.width=320;
  canvas.height=240;
  canvas.style.position="absolute";
  canvas.style.left="calc(50vw - 320px)"
  canvas.style.top="calc(50vh - 240px)"
  clientState.canvas=canvas;
  clientState.context2d=canvas.getContext("2d");
  createScalingCanvas(canvas);
 },
 refreshUI:function(state) {
  var ships=state.ships;
  var shots=state.shots;  
  var context=clientState.context2d;
  context.fillStyle="black"
  context.fillRect(0,0,640,480);
  context.lineWidth=2;
  context.lineCap="round";
  context.lineJoin="round";
  function drawTriangle(ship,size) {
   context.beginPath();
   context.moveTo(ship.x/256+size*8/5*Math.cos(ship.theta*Math.PI/180),
		  ship.y/256+size*8/5*Math.sin(ship.theta*Math.PI/180));
   context.lineTo(ship.x/256+size*Math.cos((ship.theta+120)*Math.PI/180),
		  ship.y/256+size*Math.sin((ship.theta+120)*Math.PI/180));
   context.lineTo(ship.x/256+size*Math.cos((ship.theta-120)*Math.PI/180),
		  ship.y/256+size*Math.sin((ship.theta-120)*Math.PI/180));
   context.closePath();   
  }
  M.forEachAscending(ships,function(ship) {
   if(ship.invincFrames%2==0) {
    var colors=get3ProfileColors(ship.username,ship.profile);

    context.fillStyle=colors[0];
    drawTriangle(ship,10);
    context.fill();
    context.fillStyle=colors[1];
    drawTriangle(ship,7.5);
    context.fill();
    context.fillStyle=colors[2];
    drawTriangle(ship,5);
    context.fill();
   }
  });
  for(var i in shots) {
   context.fillStyle="white";
   context.beginPath();
   context.arc(shots[i].x/256,
	       shots[i].y/256,
	       5,
	       0,
	       Math.PI*2)
   context.fill();
  }
 },
 destroyUI:function() {
 },
 getCurrentInputString:function() {
  if(isKeyFresh("KeyZ")) {
   sendGameCommand("f");
  }
  return (isKeyHeld("ArrowLeft")?"l":"")+
   (isKeyHeld("ArrowRight")?"r":"")+
   (isKeyHeld("ArrowUp")?"u":"")+
   (isKeyHeld("ArrowDown")?"d":"");  
 }
});

registerPlayset(
 {
  COLORS:["red","green","blue","yellow","cyan","magenta"],
  getName:function() { return "testgame1" },
  advanceGameState:function(state,connects,commands,inputs,disconnects) {
   var dots=state.dots
   for(var i in connects) {
    dots.push({
     x:320,
     y:320,
     width:2,
     height:2,
     color:this.COLORS[(state.nextColor||0)%this.COLORS.length],
     controller:connects[i].c,
    })
    state.nextColor=(state.nextColor||0)+1;
   }
   var dotMoves={}
   for(var i in inputs) {
    dotMoves[inputs[i].c]=inputs[i].i;
   }
   for(var i in dots) {
    if(dots[i].controller in dotMoves) {
     var move=dotMoves[dots[i].controller];
     function hasKey(k) {
      return move.indexOf(k)!=-1;
     }
     dots[i].x+=((hasKey("d"))?1:0)-((hasKey("a"))?1:0)
     dots[i].y+=((hasKey("s"))?1:0)-((hasKey("w"))?1:0)
    }
   }
   if(disconnects.length>0) {
    state.dots=dots.filter(function(dot) {
     return disconnects.indexOf(dot.controller)==-1;
    });
   }
  },
   
  initUI:function(state) {
   var canvas=document.createElement("canvas");
   canvas.width=640;
   canvas.height=480;
   canvas.style.position="absolute";
   canvas.style.left="calc(50vw - 320px)"
   canvas.style.top="calc(50vh - 240px)"
   clientState.canvas=canvas;
   clientState.context2d=canvas.getContext("2d");
   screenDiv.appendChild(canvas);
  },
  refreshUI:function(state)
  {
   var dots=state.dots;
   var context=clientState.context2d;
   context.fillStyle="black"
   context.fillRect(0,0,640,480);
   for(var i in dots) {
    context.fillStyle=dots[i].color;
    context.fillRect(dots[i].x,dots[i].y,
		     dots[i].width,dots[i].height);
   }
  },
  destroyUI:function() {
   screenDiv.innerHTML="";
  },
  getCurrentInputString:function() {
   var ret=
       (isKeyHeld("KeyA")?"a":"")+
       (isKeyHeld("KeyW")?"w":"")+
       (isKeyHeld("KeyS")?"s":"")+
       (isKeyHeld("KeyD")?"d":"");
   return ret;
  }
 }
);
