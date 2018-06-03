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

   The main difference between commands and input strings is that,
   if a user misses frames due to lag or their local cpu load, their last 
   input string will be repeated over the missed frames, while commands 
   will be delayed to happen on just the next non-missing one, not multiplied.
   For example, if positive-edge and negative-edge UI events matter, then those
   events should be explicit commands or implicit in input string changes,
   not explicitly part of the input string. Mouse clicks should pack the
   coordinates or a stable identifier for the targeted object into the command.
*/

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
   }
   state.nextColor=(state.nextColor||0)+1;
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
  
   return (isKeyHeld("KeyA")?"a":"")+
    (isKeyHeld("KeyW")?"w":"")+
    (isKeyHeld("KeyS")?"s":"")+
    (isKeyHeld("KeyD")?"d":"");
    
  }
 }
);
