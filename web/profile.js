"use strict"

/* support for client-side handling of user profile strings */

const PROFILE_CODE_TO_COLOR_INDEX={
 '0':0, '1':1, '2':2, '3':3, '4':4, '5':5, '6':6, '7':7,
 '8':8, '9':9, a:10, b:11, c:12, d:13, e:14, f:15,
 g:16, h:17, i:18, j:19, k:20, l:21, m:22, n:23,
 o:24, p:25, q:26, r:27, s:28, t:29, u:30, v:31
}

const PROFILE_COLOR_INDEX_TO_CODE="0123456789abcdefghijklmnopqrstuv";

const PROFILE_COLORS=[
 // bright ROYGTCBVM
 "#ff0000", "#ff8000", "#ffff00",
 "#00ff00", "#00ff80", "#00ffff",
 "#0000ff", "#8000ff", "#ff00ff",

 // dark ROYGTCBVM
 "#800000", "#804000", "#808000",
 "#008000", "#008040", "#008080",
 "#000080", "#400080", "#800080",

 // pale ROYGTCBVM
 "#c08080", "#c0a080", "#c0c080",
 "#80c080", "#80c0a0", "#80c0c0",
 "#8080c0", "#a080c0", "#c080c0",

 // 5 greys
 "#c0c0c0", "#a0a0a0", "#808080", "#606060", "#404040", 
]

function sanitizeProfile(username,profile) {
 if(!profile) { profile=""; }
 var n=0;
 var index1,index2,index3;
 for(var i in username) {
  n=(n*8191+username.charCodeAt(i)*65535+
     username.charCodeAt(i)*username.charCodeAt(i)*127+
     username.charCodeAt(i)*username.charCodeAt(i)*username.charCodeAt(i))
   %2147483647;
 }
 if(profile[0] in PROFILE_CODE_TO_COLOR_INDEX) {
  index1=PROFILE_CODE_TO_COLOR_INDEX[profile[0]];
 }
 else {
  index1=(n>>10)%32
 }
 if(profile[1] in PROFILE_CODE_TO_COLOR_INDEX) {
  index2=PROFILE_CODE_TO_COLOR_INDEX[profile[1]];
 }
 else {
  index2=(n>>5)%32
 }
 if(profile[2] in PROFILE_CODE_TO_COLOR_INDEX) {
  index3=PROFILE_CODE_TO_COLOR_INDEX[profile[2]];
 }
 else {
  index3=n%32
 }
 if(index2==index1) { index2=(index2+1)%32; }
 while(index3==index2 || index3==index1) { index3=(index3+1)%32; }

 return PROFILE_COLOR_INDEX_TO_CODE[index1]+
  PROFILE_COLOR_INDEX_TO_CODE[index2]+
  PROFILE_COLOR_INDEX_TO_CODE[index3]; 
}

function get3ProfileColors(username,profile) {
 profile=sanitizeProfile(username,profile);
 return [
  PROFILE_COLORS[PROFILE_CODE_TO_COLOR_INDEX[profile[0]]],
  PROFILE_COLORS[PROFILE_CODE_TO_COLOR_INDEX[profile[1]]],
  PROFILE_COLORS[PROFILE_CODE_TO_COLOR_INDEX[profile[2]]],
 ] 
}

/* 
   username - the username (for defaulting purposes)
   initialProfile - the profile string to start with
   callback - if present, this is called with the profile string 
              whenever the user changes it          
   returns a div element with an updating "data-profile" attribute 
*/
function makeProfileWidget(username,initialProfile,callback) {
 function onChange() {
  var unsanitized=
      PROFILE_COLOR_INDEX_TO_CODE[selects[0].value]+
      PROFILE_COLOR_INDEX_TO_CODE[selects[1].value]+
      PROFILE_COLOR_INDEX_TO_CODE[selects[2].value];
  div["data-profile"]=sanitizeProfile(username,unsanitized);
  setShownValues()
  if(callback) { callback(div["data-profile"]); }
 }

 function setShownValues() {
  for(var i=0;i<3;++i) {
   var index=PROFILE_CODE_TO_COLOR_INDEX[div["data-profile"][i]];
   selects[i].value=index;
   selects[i].style.color=PROFILE_COLORS[index];
  }
  context.fillStyle="black";
  context.fillRect(0,0,100,100);
  context.fillStyle="white";
  context.beginPath();
  context.moveTo(5,95);
  context.lineTo(95,95);
  context.lineTo(95,5);
  context.closePath();
  context.fill();
  
  context.fillStyle=selects[0].style.color;
  context.beginPath();
  context.moveTo(50,10);
  context.lineTo(80,80);
  context.lineTo(20,80);
  context.closePath();
  context.fill();

  context.fillStyle=selects[1].style.color;
  context.beginPath();
  context.moveTo(50,22);
  context.lineTo(72,75);
  context.lineTo(28,75);
  context.closePath();
  context.fill();
  
  context.fillStyle=selects[2].style.color;
  context.beginPath();
  context.moveTo(50,34);
  context.lineTo(64,70);
  context.lineTo(36,70);
  context.closePath();
  context.fill();
 }
 
 var profile=sanitizeProfile(username,initialProfile);
 var div=document.createElement("div");
 var canvas=document.createElement("canvas");
 canvas.width=100;
 canvas.height=100;
 var context=canvas.getContext("2d");
 div.appendChild(canvas);
 var selects=[]
 for(var i=0;i<3;++i) {
  var label=document.createElement("label");
  label.innerText="Color "+(i+1)+": ";
  var select=document.createElement("select");
  label.appendChild(select);
  for(var j=0;j<32;++j) {
   var option=document.createElement("option");
   option.value=j
   option.innerHTML='\u2588\u2588\u2588';
   option.style.color=PROFILE_COLORS[j];
   select.appendChild(option);
  }
  select.onchange=onChange;
  selects[i]=select;
  div.appendChild(label);
  var space=document.createElement("span");
  space.innerText=" ";
  div.appendChild(space);
 }
 div["data-profile"]=profile;
 setShownValues();
 return div;
}
