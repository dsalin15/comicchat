/* jslint node: true */
'use strict';

function log (text) {
  console.log("\n" + (new Date()) + "\n" + text);
}

var net = require('net');
var tls = require('tls');
var WebSocketClient = require('websocket').client;

var config = {
  cchat: {
    nick: 'example',
    room: '#relay',
    host: 'localhost',
    port: 8084,
    roomLink:  'http://localhost:8080/#relay'
  },
  irc: {
    nick: 'example',
    user: 'example',
    real: 'relay',
    channels: [ '#e' ],
    host: 'irc.retronode.org',
    port: 6697,
    ssl: true
  }
};

// ====================== ЗАЩИТА ======================
var wsConnection = null;
var recentlySentFromIRC = new Set();

function makeComicChat () {
  var wsRetryHandlerID = null;

  var reconnect = function () {
    if (wsRetryHandlerID === null) {
      wsRetryHandlerID = setInterval(() => makeComicChat(), 8000);
    }
  };

  function addHandlers (ws) {
    ws.on('connect', function (connection) {
      log('CC: Connected');
      wsConnection = connection;

      if (wsRetryHandlerID) clearInterval(wsRetryHandlerID);

      connection.sendUTF(JSON.stringify({ type: 'join', room: config.cchat.room }));
      connection.sendUTF(JSON.stringify({ type: 'message', room: config.cchat.room, text: config.cchat.nick + " [RELAY]" }));

      connection.on('message', function (message) {
        if (message.type !== 'utf8') return;

        try {
          var msg = JSON.parse(message.utf8Data);

          if (msg.type !== 'message' || msg.room !== config.cchat.room) return;
          if (!msg.text || !msg.author) return;

          var rawText = msg.text.trim();
          var author = msg.author.trim();

          // === УЛУЧШЕННАЯ ЗАЩИТА ===
          if (msg.spoof === true) {
            log('CC → BLOCKED (spoof true)');
            return;
          }
          if (author === config.irc.nick || author === config.cchat.nick) {
            log('CC → BLOCKED (our own nick)');
            return;
          }
          if (rawText.includes('@cc>') || rawText.includes('[RELAY]')) {
            log('CC → BLOCKED (loop signature)');
            return;
          }

          // Проверка по recentlySentFromIRC
          var loopKey = author + "|" + rawText;
          if (recentlySentFromIRC.has(loopKey)) {
            log('CC → BLOCKED (recently sent from IRC)');
            return;
          }

          log(`CC → RELAYING ${author}: ${rawText}`);

          var relayText = `<${author}@cc> ${rawText}`;

          config.irc.channels.forEach(ch => {
            irc.raw(`PRIVMSG ${ch} :${relayText}`);
          });
        } catch (e) {
          log('CC: Parse error');
        }
      });

      connection.on('error', reconnect);
      connection.on('close', reconnect);
    });

    return ws;
  }

  var ws = addHandlers(new WebSocketClient());
  ws.on('connectFailed', reconnect);
  ws.connect('ws://' + config.cchat.host + ':' + config.cchat.port);
}

// ====================== IRC ======================
var irc = { listeners: [], pingTimerID: null };

function makeIRC() {
  var connectHandler = function () {
    log('IRC: Connected');

    irc.on(/^PING :(.+)$/i, (info) => irc.raw('PONG :' + info[1]));

    irc.on(/^.+ 001 .+$/i, () => {
      config.irc.channels.forEach(ch => irc.raw('JOIN ' + ch));
    });

    irc.on(/^:(.+)!.+@.+ PRIVMSG .+? :(.+)$/i, function (info) {
      if (!wsConnection) return;

      var author = info[1];
      var text = info[2].trim();
      var loopKey = author + "|" + text;

      // Запоминаем, что мы только что отправили это сообщение
      recentlySentFromIRC.add(loopKey);
      setTimeout(() => recentlySentFromIRC.delete(loopKey), 8000);

      log(`IRC → CC [${author}]: ${text}`);

      wsConnection.sendUTF(JSON.stringify({
        type: 'message',
        room: config.cchat.room,
        text: text,
        author: author,
        spoof: true
      }));
    });

    irc.raw('NICK ' + config.irc.nick);
    irc.raw('USER ' + config.irc.user + ' 8 * :' + config.irc.real);

    if (irc.pingTimerID) clearInterval(irc.pingTimerID);
    irc.pingTimerID = setInterval(() => irc.raw('PING BONG'), 60000);
  };

  if (config.irc.ssl === true) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    irc.socket = tls.connect(config.irc.port, config.irc.host);
    irc.socket.on('secureConnect', connectHandler);
  } else {
    irc.socket = new net.Socket();
    irc.socket.on('connect', connectHandler);
    irc.socket.connect(config.irc.port, config.irc.host);
  }

  irc.socket.setEncoding('utf-8');

  irc.handle = function (data) {
    for (var i = 0; i < irc.listeners.length; i++) {
      var match = irc.listeners[i][0].exec(data);
      if (match) irc.listeners[i][1](match);
    }
  };

  irc.on = function (regex, cb) { irc.listeners.push([regex, cb]); };
  irc.raw = function(data) {
    if (data) irc.socket.write(data + '\n', 'utf-8');
  };

  irc.socket.on('data', function (data) {
    data.split("\n").forEach(line => {
      line = line.trim();
      if (line) {
        log('IRC <- ' + line);
        irc.handle(line.replace(/\r$/, ''));
      }
    });
  });

  irc.socket.on('close', () => setTimeout(makeIRC, 5000));
  irc.socket.on('error', () => setTimeout(makeIRC, 5000));
}

makeComicChat();
makeIRC();
