"use strict"

function onCUClick() {
 var buttonCU=document.getElementById("buttonCU");
 if(!buttonCU.disabled) {
  var username=document.getElementById("usernameInputCU").value;
  var password=document.getElementById("passwordInputCU").value;
  var config=""; // todo
  var message=JSON.stringify({
   "k":"selfServeCreateUser",
   "u":username,
   "p":password,
   "d":config,
  })
  sendAPIMessage(message,onCUError,function(successString) {
   onCUResult(successString,username,password);
  });
  buttonCU.disabled=true;
 }
}

function onCUError(errorString) {
 document.getElementById("resultCU").innerText=errorString;
 document.getElementById("buttonCU").disabled=false;
}

function onCUResult(successString,username,password) {
 document.getElementById("usernameInputP").value=username;
 document.getElementById("passwordInputP").value=password;
 document.getElementById("resultCU").innerText=successString;
 document.getElementById("buttonCU").disabled=false;
 onPClick();
}

function onCPClick() {
 var buttonCP=document.getElementById("buttonCP");
 if(!buttonCP.disabled) {
  var username=document.getElementById("usernameInputCP").value;
  var password=document.getElementById("passwordInputCP").value;
  var newPassword=document.getElementById("newPasswordInputCP").value;
  var message=JSON.stringify({
   "k":"changeMyPassword",
   "u":username,
   "p":password,
   "n":newPassword,
  })
  sendAPIMessage(message,onCUError,onCPResult);
  buttonCP.disabled=true;
 }
}

function onCPError(errorString) {
 document.getElementById("resultCP").innerText=errorString;
 document.getElementById("buttonCP").disabled=false;
}

function onCPResult(successString) {
 document.getElementById("resultCP").innerText=successString;
 document.getElementById("buttonCP").disabled=false;
}

function onPClick() {
 var buttonP=document.getElementById("buttonP");
 if(!buttonP.disabled) {
  var username=document.getElementById("usernameInputP").value;
  var password=document.getElementById("passwordInputP").value;
  var message=JSON.stringify({
   "k":"getMyConfig",
   "u":username,
   "p":password,
  })
  sendAPIMessage(message,onPError,function(successString) {
   console.log(successString);
   onPResult(successString,username,password);
  });
  buttonP.disabled=true;
 }
}

function onPError(errorString) {
 document.getElementById("resultP").innerText=errorString;
 document.getElementById("buttonP").disabled=false;
 document.getElementById("profileWidgetDiv").innerHTML="";
  document.getElementById("buttonPSubmit").style.display="none"
}

function onPResult(successString,username,password) {
 document.getElementById("resultP").innerHTML="";
 var submit=document.getElementById("buttonPSubmit");
 var outerDiv=document.getElementById("profileWidgetDiv");
 outerDiv.innerHTML="";
 outerDiv.appendChild(makeProfileWidget(username,successString,
					function(profile) {
					 submit["data-profile"]=profile;
					 submit.disabled=false;
					}
				       ))
 document.getElementById("buttonP").disabled=false;
 submit.style.display="inline";
 submit["data-password"]=password;
 submit["data-username"]=username;
 submit["data-profile"]=successString;
 submit.disabled=true;
}

function onPSubmitClick() {
 var buttonPSubmit=document.getElementById("buttonPSubmit");
 if(!buttonPSubmit.disabled && buttonP.style.display!="none") {
  var message=JSON.stringify({
   "k":"setMyConfig",
   "u":buttonPSubmit["data-username"],
   "p":buttonPSubmit["data-password"],
   "d":buttonPSubmit["data-profile"],
  })
  sendAPIMessage(message,onPError,function() {
   document.getElementById("buttonPSubmit").innerText="Submit";
  });
  document.getElementById("buttonPSubmit").disabled=true;
  document.getElementById("buttonPSubmit").innerText="Wait...";
 }
}

function onShutdownClick(clean) {
 var username=document.getElementById("usernameInputA").value;
 var password=document.getElementById("passwordInputA").value;
 var reason=document.getElementById("reasonInputA").value;
 var message=JSON.stringify({
  "k":clean?"cleanShutdown":"dirtyShutdown",
  "u":username,
  "p":password,
  "r":reason
 })
 sendAPIMessage(message,onShutdownError,onShutdownResult);
}

function onShutdownError(errorString) {
 document.getElementById("resultAdmin").innerText=errorString;
}

function onShutdownResult(successString) {
 document.getElementById("resultAdmin").innerText=successString;
}

function sendAPIMessage(message,error,success) {
 var done=false;
 try {
  var socket=new WebSocket(OKAY_SOCKET_SERVER_URL);
  socket.addEventListener("error",function() {
   if(!done) {
    done=true;
    error("Connection error (server may be down)");
    }
  })  
  socket.addEventListener("open", function() {
   socket.send(message);
   this.addEventListener("close",function() {
    if(!done) {
     done=true;
     error("Connection suddenly closed (server may be down)");
    }
   })
   this.addEventListener("message",function(e) {
    // API calls just return one message and end
    var message=JSON.parse(e.data);
    switch(message.k) {
    case "E": error(message.e); break;
    case "D": success(message.d); break;
    }
    done=true;
   });
  });
 }
 catch(e) {
  if(!done) {
   console.error(e);
   error("an error has occured (server may be down)");
  }
 }
}

