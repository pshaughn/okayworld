"use strict"

const OKAY_SOCKET_PORT=8081
const OKAY_SOCKET_PROTOCOL=location.protocol=="https:"?"wss:":"ws:"
const OKAY_SOCKET_SERVER_URL=
      OKAY_SOCKET_PROTOCOL+"//"+location.hostname+":"+OKAY_SOCKET_PORT;
  
