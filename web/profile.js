"use strict"

/* support for client-side interpretation of user profile strings */

const PROFILE_COLOR_CODES={
 "0":"#ff0000",
 "1":"#ff8000",
 "2":"#ffff00",
 "3":"#00ff00",
 "4":"#00ff80",
 "5":"#00ffff",
 "6":"#0000ff",
 "7":"#8000ff",
 "8":"#ff00ff",

 "9":"#800000",
 "a":"#804000",
 "b":"#808000",
 "c":"#008000",
 "d":"#008040",
 "e":"#008080",
 "f":"#000080",
 "g":"#400080",
 "h":"#800080",

 "i":"#c08080",
 "j":"#c0a080",
 "k":"#c0c080",
 "l":"#80c080",
 "m":"#80c0a0",
 "n":"#80c0c0",
 "o":"#8080c0",
 "p":"#a080c0",
 "q":"#c080c0",

 "r":"#c0c0c0",
 "s":"#a0a0a0",
 "t":"#808080",
 "u":"#606060",
 "v":"#404040", 
}

function get3ProfileColors(username,profile) {
 // these defaults are bad: the %32 is making it so most of the string
 // doesn't even matter, and it's not avoiding multiples of the same color.
 function pickColor(div) {
  var n=0;
  for(var i in username) {
   n=n*256+username.charCodeAt(i);
  }
  return "0123456789abcdefghijklmnopqrstuv"[Math.floor(n/div)%32];
 }
 var code1=profile[0];
 if(!(code1 in PROFILE_COLOR_CODES)) { code1=pickColor(1); }
 var code2=profile[1];
 if(!(code2 in PROFILE_COLOR_CODES) || code2==code1) { code2=pickColor(5); }
 var code3=profile[2];
 if(!(code3 in PROFILE_COLOR_CODES) || code3==code2 || code3==code1) {
  code3=pickColor(17);
 }
 return [
  PROFILE_COLOR_CODES[code1],
  PROFILE_COLOR_CODES[code2],
  PROFILE_COLOR_CODES[code3] 
 ]
}
