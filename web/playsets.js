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

   Playsets must have:
   .getName(): return constant string different from any other playset name
   .advanceGameState(gameState, connects, commands, inputs, disconnects):
     -- gameState is a game state
     -- connects is a list of {c:controllerID, u:username, d:userConfigString}
     -- commands is a list of {c:controllerID, o:commandString}
     -- inputs is a list of {c:controllerID, i:inputString}
     -- disconnects is a list of controller IDs
     mutate game state by applying these and one frame's worth of game logic,
     without referencing anything dynamic. unexpected arguments must be
     tolerated, including redundant connects/disconnects, bad command strings,
     bad input strings, and completely arbitrary config strings, without any 
     nondeterminism in the result (except the data types of inputs will 
     be the correct data types and don't need checking, and the order of 
     items in each list can be trusted as deterministic)
    .getCurrentInputString(): called only by client, encode current user inputs
                              (not necessarily every frame, but be fast)
    .initUI(gameState): called only by client
    .refreshUI(gameState,frameNumber): called only by client, 
     not necessarily every frame, possibly more than once for the same frame,
     possibly out of order
    .destroyUI(): called only by client, if connection drops


    Playsets with non-JSON-serializable game states must have:
    .deserializeGameState(str): convert string to a game state
    .serializeGameState(gameState): convert game state to string
    
    Playsets may have:
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
   sendGameCommand(str): issue a command event (next time a frame is sent)
   isKeyHeld(code): boolean
   isKeyFresh(code): boolean, true if there's a positive-edge since last frame
   getOwnControllerId(): returns controller ID of local player

   clientState is an otherwise-empty object in the client's global namespace,
   made available so client-only methods can avoid having to put things in the
   global namespace (e.g. handles to DOM elements they create)

   screenDiv is a DOM element in the client's global namespace that's a div 
   to put the game UI in; it's empty going into initUI

   Sending a game command as a side effect during getCurrentInputString is
   allowed, as is sending one from a DOM event that was set up by initUI or
   refreshUI.

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
   not explicitly part of the input string. Mouse clicks should pack the
   coordinates or a stable identifier for the targeted object into the command.
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
  if(result<0) { return result+b; }
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
}

registerPlayset({
 RNG_MODULUS:Math.pow(2,31)-1,
 getName:function() { return "spaceduel" },
 rand:function(state,n) {
  state.prng=((state.prng||1)*16807)%this.RNG_MODULUS
  return state.prng%n;
 },

 advanceGameState:function(state,connects,commands,inputs,disconnects) {
  var thisPlayset=this;
  function respawnShip(ship) {
   var x=thisPlayset.rand(state,320*256)+160*256;
   var y=thisPlayset.rand(state,320*256)+80*256;
   var theta=thisPlayset.rand(state,360);
   ship.x=x;
   ship.y=y;
   ship.theta=theta;
   ship.invincFrames=60;
   ship.shotTimeout=60;
   ship.xv=0;
   ship.yv=0;
  }
  this.rand(state);
  for(var i in connects) {
   var x=this.rand(state,320*256)+160*256;
   var y=this.rand(state,320*256)+80*256;
   var theta=this.rand(state,360);
   var s={
    controller:connects[i].c,
    username:connects[i].u,
    profile:connects[i].d,
   };
   respawnShip(s);
   state.ships.push(s);
  }
  var updates={}
  for(var i in inputs) {
   updates[inputs[i].c]=[inputs[i].i];
  }
  for(var i in commands) {
   if(commands[i].o=="f" && commands[i].c in updates) {
    updates[commands[i].c][1]=true;
   }
  }
  state.ships=state.ships.filter(function(s) {
   return disconnects.indexOf(s.controller)==-1;
  });
  var ships=state.ships
  var shots=state.shots
  for(var i in ships) {
   var c=ships[i].controller;
   if(updates[c]) {
    if(updates[c][0].indexOf("l")!=-1) { ships[i].theta-=3; }
    if(updates[c][0].indexOf("r")!=-1) { ships[i].theta+=3; }
    ships[i].theta=M.mod(ships[i].theta,360);
    if(updates[c][0].indexOf("u")!=-1) {
     ships[i].xv+=M.trunc(M.cos256(ships[i].theta)/2);
     ships[i].yv+=M.trunc(M.sin256(ships[i].theta)/2);
    }
   }
   ships[i].xv=M.trunc(ships[i].xv*127/128);
   ships[i].yv=M.trunc(ships[i].yv*127/128);
   var v2=ships[i].xv*ships[i].xv+ships[i].yv*ships[i].yv;
   if(v2>1024*1024) {
    var v=M.floorsqrt(v2);
    ships[i].xv=M.trunc(ships[i].xv*1024/v);
    ships[i].yv=M.trunc(ships[i].yv*1024/v);
   }
   ships[i].x+=ships[i].xv;
   ships[i].y+=ships[i].yv;
   if(ships[i].invincFrames) { --ships[i].invincFrames; }
   if(ships[i].shotTimeout) { --ships[i].shotTimeout; }
   if(ships[i].shotTimeout==0 && updates[c][1]) {
    shots.push({
     x:ships[i].x,
     y:ships[i].y,
     xv:M.cos256(ships[i].theta)*6+ships[i].xv,
     yv:M.sin256(ships[i].theta)*6+ships[i].yv,
     controller:c
    });
    ships[i].shotTimeout=10;
   }
   if(ships[i].x<0 || ships[i].y<0 ||
      ships[i].x>640*256 || ships[i].y>480*256) {
    respawnShip(ships[i]);
   }
  }
  for(var i in shots) {
   shots[i].x+=shots[i].xv;
   shots[i].y+=shots[i].yv;
   for(var j in ships) {
    if(ships[j].controller != shots[i].controller &&
      ships[j].invincFrames==0 && !shots[i].done) {
     var dx=ships[j].x-shots[i].x;
     var dy=ships[j].y-shots[i].y;
     if(dx*dx+dy*dy<(10*256)*(10*256)) {
      respawnShip(ships[j]);
      shots[i].done=true
     }     
    }
   }
  }
  state.shots=shots.filter(function(s) {
   return s.x>0 && s.x<640*256 && s.y>0 && s.y<480*256 && !s.done;
  })
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
 refreshUI:function(state) {
  var ships=state.ships;
  var shots=state.shots;  
  var context=clientState.context2d;
  context.fillStyle="black"
  context.fillRect(0,0,640,480);
  context.lineWidth=2;
  context.lineCap="round";
  context.lineJoin="round";
  function drawTriangle(size) {
   context.beginPath();
   context.moveTo(ships[i].x/256+size*8/5*Math.cos(ships[i].theta*Math.PI/180),
		  ships[i].y/256+size*8/5*Math.sin(ships[i].theta*Math.PI/180));
   context.lineTo(ships[i].x/256+size*Math.cos((ships[i].theta+120)*Math.PI/180),
		  ships[i].y/256+size*Math.sin((ships[i].theta+120)*Math.PI/180));
   context.lineTo(ships[i].x/256+size*Math.cos((ships[i].theta-120)*Math.PI/180),
		  ships[i].y/256+size*Math.sin((ships[i].theta-120)*Math.PI/180));
   context.closePath();   
  }
  for(var i in ships) {
   if(ships[i].invincFrames%2==0) {
    var colors=get3ProfileColors(ships[i].username,ships[i].profile);

    context.fillStyle=colors[0];
    drawTriangle(10);
    context.fill();
    context.fillStyle=colors[1];
    drawTriangle(7.5);
    context.fill();
    context.fillStyle=colors[2];
    drawTriangle(5);
    context.fill();
   }
  }
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
  screenDiv.innerHTML="";
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
