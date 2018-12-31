const app = require('express')();
const server = require('http').createServer(app);
const pages = require('./controllers/routes/index');
const socketsession = require('express-socket.io-session');
const redis = require('./controllers/database/redis');
const io = require('socket.io')(server);
const dataScheme = require('./config/dataset');
const configure = require('./config/main.config');
const { logger, dataLogger } = require('./utilities/logger/winston');
const serverPort = 80;

// 앱 설정
configure(app);
app.use('/', pages);

const ChatSocketIO = io.of('/roomspace');
ChatSocketIO.use(socketsession(app.session, { autoSave: true }));

// 방 => 추후 이동
let rooms = require('./controllers/socketio/rooms');

ChatSocketIO.on('connection', socket => {

  socket.userRooms = [];
  const usersession = socket.handshake.session;
  logger.custLog(`사용자가 접속하였습니다. 해당 사용자의 아이디는 ${socket.id} 입니다. 소켓 접속에 사용자의 세션 정보를 불러옵니다.`, usersession);

  // 로그인
  const userStatus = require('./controllers/socketio/events/userStatus');
  socket.on('user:status', userStatus.bind(socket));
  const userCreateNickname = require('./controllers/socketio/events/userCreateNickname');
  socket.on('user:create:nickname', userCreateNickname.bind(socket));

  // 게임방
  const roomsRefresh = require('./controllers/socketio/events/refreshRoom');
  socket.emit('rooms:info', filterRooms(rooms));
  socket.on('rooms:refresh', roomsRefresh.bind(socket));

  const createRoom = require('./controllers/socketio/events/createRoom');
  socket.on('create:room', createRoom.bind(socket));
  const joinRoom = require('./controllers/socketio/events/joinRoom');
  socket.on('join:room', joinRoom.bind(socket));
  const getSubject = require('./controllers/socketio/events/getSubject');
  socket.on('get:subject', getSubject.bind(socket));
  const leaveRoom = require('./controllers/socketio/events/leaveRoom');
  socket.on('leave:room', leaveRoom.bind(socket));

  // 인게임
  const sendMessage = require('./controllers/socketio/events/sendMessage');
  socket.on('send:message', sendMessage.bind(socket));

  socket.on('ready:user', () => {
    logger.custLog("[ready:user] 유저의 준비 요청.");
    const userinfo = usersession.userinfo;
    const userRoom = socket.userRooms[0];
    let selectedRoom = getSelectedRoom(rooms, userRoom);
    if (userinfo.ready) {
      logger.custLog("[ready:user] 유저의 준비되지 않은 유저", usersession);
      userinfo.ready = false;
      selectedRoom.ready--;
      if (selectedRoom.readiedPlayer.indexOf(userinfo.nickname) > -1) {
        selectedRoom.readiedPlayer.splice(selectedRoom.readiedPlayer.indexOf(userinfo.nickname), 1);
      }
      ChatSocketIO.to(socket.userRooms[0]).emit('ready:user', userinfo);
      ChatSocketIO.to(socket.userRooms[0]).emit("all:ready", false);
    } else {
      logger.custLog("[ready:user] 유저의 준비된 유저", usersession);
      userinfo.ready = true;
      selectedRoom.readiedPlayer.push(userinfo.nickname);
      selectedRoom.ready++;
      ChatSocketIO.to(socket.userRooms[0]).emit('ready:user', userinfo);
      selectedRoom.ready >= 2 && selectedRoom.ready === selectedRoom.members.length && ChatSocketIO.to(socket.userRooms[0]).emit("all:ready", true);
    }
  });

  socket.on('start:game', () => {
    logger.custLog("[start:game] 방장의 시작 요청.");
    const userinfo = usersession.userinfo;
    const userRoom = socket.userRooms[0];
    let selectedRoom = getSelectedRoom(rooms, userRoom);
    selectedRoom.playingMembers = deepCopy(selectedRoom.members);
    selectedRoom.ballotBox = selectedRoom.ballotBox.filter((member) => (member));
    logger.custLog("[start:game] 시작하려는 방 정보: ", selectedRoom);
    logger.custLog("[start:game] 시작하려는 방 구성인원: ", selectedRoom.playingMembers);
    selectedRoom.status = "playing";
    /* 거짓말쟁이 추출 */
    const playersLength = selectedRoom.playingMembers.length;
    const liar = selectedRoom.playingMembers[Math.floor(Math.random() * playersLength)];
    /* 첫 시작 플레이어 추출 */
    const targetNumber = Math.floor(Math.random() * playersLength);
    const firstOrder = selectedRoom.playingMembers[targetNumber];
    selectedRoom.playingMembers.splice(targetNumber, 1);
    /* 제시어 선택 */
    redis.smembers(selectedRoom.subject, (error, suggests) => {
      const targetFood = Math.floor(Math.random() * suggests.length);
      const selectedFood = suggests[targetFood];
      selectedRoom.gameRole = selectedFood;
      selectedRoom.currentUsers.forEach(memberData => {
        logger.custLog("[start:game] 판별: ", memberData);
        if (memberData.nickname === liar) {
          logger.custLog("[start:game] 거짓말쟁이: ", memberData);
          memberData.role = 'liar';
          const serviceData = { firstPlayer: firstOrder, role: "거짓말쟁이" };
          ChatSocketIO.to(memberData.socketId).emit("role:game", serviceData);
        } else {
          logger.custLog("[start:game] 제시어를 받은 사람: ", memberData);
          memberData.role = 'innocent';
          const serviceData = { firstPlayer: firstOrder, role: selectedFood };
          ChatSocketIO.to(memberData.socketId).emit("role:game", serviceData);
        }
      });
    });
  });

  socket.on('explain:game', (data) => {
    logger.custLog("[explain:game] 게임 설명을 마치고 다음 사람에게 설명 차례라는 내용을 전달해주어야 합니다.", data);
    try {
      const userRoom = socket.userRooms[0];
      let selectedRoom = getSelectedRoom(rooms, userRoom);
      logger.custLog("[explain:game] 현재 남은 설명할 사람: ", selectedRoom.playingMembers);
      const playersLength = selectedRoom.playingMembers.length;
      const targetNumber = Math.floor(Math.random() * playersLength);
      const nextOrder = selectedRoom.playingMembers[targetNumber];
      selectedRoom.playingMembers.splice(targetNumber, 1);

      if (data.hasOwnProperty("explain")) {
        if (playersLength > 0) {
          const serviceData = { nextPlayer: nextOrder, explain : data.explain, explaingPlayer: data.explaingPlayer };
          logger.custLog("[explain:game] 전달할 데이터", serviceData);
          ChatSocketIO.to(socket.userRooms[0]).emit("explain:game", serviceData);
        } else {
          logger.custLog("[explain:game] 설명할 사람이 남지 않았습니다. 난상토론으로 넘어갑니다.");
          ChatSocketIO.to(socket.userRooms[0]).emit("discuss:game", { explain: data.explain, explaingPlayer: data.explaingPlayer });
        }
      } else {
        logger.custLog("[explain:game] None data exception: 전달할 메세지가 들어오지 않았습니다.", data);
      }


    } catch (e) {
      logger.custLog(`[explain:game]${e}`);
    }
  });

  socket.on('end:discuss', (data) => {
    logger.custLog("[end:discuss] 토론 종료", data);
    const selectedRoom = getSelectedRoom(rooms, socket.userRooms[0]);
    if (!selectedRoom.discussEnd) {
      selectedRoom.discussEnd = true;
      logger.custLog('투표자들', selectedRoom.currentUsers.map(userinfo => userinfo.nickname));
      ChatSocketIO.to(socket.userRooms[0]).emit("vote:list", selectedRoom.currentUsers.map(userinfo => userinfo.nickname));
    }
  });

  socket.on('vote:game', (data) => {
    logger.custLog('[vote:gmae] 투표한 사람에 대한 데이터: ', data);
    const selectedRoom = getSelectedRoom(rooms, socket.userRooms[0]);

    selectedRoom.ballotBox = selectedRoom.ballotBox.filter((member) => (member));
    selectedRoom.ballotBox.push(data.liarID);
    selectedRoom.senderID.push(data.senderID);

    ChatSocketIO.to(socket.userRooms[0]).emit("vote:senderID", data.senderID);
    if (selectedRoom.ballotBox.length === selectedRoom.currentUsers.length) {
      const result = {
        liar: selectedRoom.currentUsers.filter((member) => member.role === 'liar')[0].nickname,
        result: selectedRoom.ballotBox
      };
      logger.custLog('보낼 결과물: ', result);
      ChatSocketIO.to(socket.userRooms[0]).emit("vote:game", result);
    }
  });

  socket.on('last:chance', () => {
    logger.custLog('[last:chance]거짓말쟁이가 검거되었습니다. 최후의 제시어 확인 발표를 진행합니다.');
    const selectRoom = getSelectedRoom(rooms, socket.userRooms[0]);
    const subject = selectRoom.gameRole;

    redis.smembers(selectRoom.subject, (error, suggests) => {
      const originalDatasLength = suggests.length;
      if (originalDatasLength > 25) {
        suggests.splice(suggests.indexOf(subject), 1);
      }
      const resultLength = suggests.length >= 25 ? 25 : suggests.length;
      for (let index = 0; index < resultLength; index++) {
        const target = Math.floor(Math.random() * suggests.length);
        const temp = suggests[target];
        suggests.splice(target, 1);
        suggests.splice(0, 0, temp);
      }

      let result = [];
      if (originalDatasLength > 25) {
        result = suggests.slice(0, resultLength - 1);
        const collectTarget = Math.floor(Math.random() * result.length);
        result.splice(collectTarget, 0, subject);
      } else {
        result = suggests;
      }

      ChatSocketIO.to(socket.userRooms[0]).emit("last:chance", result);
    });
  });

  socket.on('last:answer', (word) => {
    logger.custLog('[last:answer]거짓말쟁이가 검거되었습니다. 최후의 제시어 확인 발표를 진행합니다.');
    const selectRoom = getSelectedRoom(rooms, socket.userRooms[0]);
    if (selectRoom.gameRole === word) {
      logger.custLog('거짓말쟁이가 제시어를 맞췄습니다!');
      ChatSocketIO.to(socket.userRooms[0]).emit("last:answer", true);
    } else {
      logger.custLog('거짓말쟁이가 제시어를 틀렸습니다!');
      ChatSocketIO.to(socket.userRooms[0]).emit("last:answer", false);
    }
  });

  const endGame = require('./controllers/socketio/events/endGame');
  socket.on('end:game', endGame.bind(socket));

  socket.on('disconnect', () => {
    logger.custLog("[disconnect] 유저의 연결이 끊어졌습니다.");

    try {
      /* 유저가 들어간 방 찾기 */
      const roomId = usersession.userinfo.room;
      const userNickname = usersession.userinfo.nickname;
      ChatSocketIO.to(roomId).emit("user:exit", userNickname);
      logger.custLog('나간 사람: ', usersession.userinfo);
      logger.custLog('유저의 로그 데이터: ', roomId, userNickname);
      let selectedRoom = getSelectedRoom(rooms, roomId);
      logger.custLog("[disconnect] 선택된 방의 정보: ", selectedRoom);
      selectedRoom.members.splice(selectedRoom.members.indexOf(userNickname), 1);
      leaveAllRoom(socket);

      if (selectedRoom.readiedPlayer.indexOf(userNickname) > -1) {
        selectedRoom.readiedPlayer.splice(selectedRoom.readiedPlayer.indexOf(userNickname), 1);
        selectedRoom.ready--;
      }

      selectedRoom.currentUsers.forEach((memberData, index) => {
        if (memberData.nickname === userNickname) {
          selectedRoom.currentUsers.splice(index, 1);
        }
      });

      if (selectedRoom.members.length === 0) {
        logger.custLog("[disconnect] 방에 아무도 없어 방을 삭제합니다.", selectedRoom);
        rooms.splice(rooms.indexOf(selectedRoom), 1);
      } else if (selectedRoom.host === userNickname) {
        logger.custLog("[leave:room] 방장이 방을 나가 새로운 방장을 임명합니다.", selectedRoom);
        selectedRoom.host = selectedRoom.members[0];
        ChatSocketIO.to(roomId).emit("host:change", selectedRoom.host);
      }

    } catch (error) {
      logger.custLog("[ERROR][disconnect] => ", error);
    }
  });

  function leaveAllRoom(socket) {
    const currentRooms = socket.userRooms;
    usersession.userinfo.ready = false;
    currentRooms.forEach((elem) => {
      socket.leave(elem);
    });
    socket.userRooms = [];
  }
});

server.listen(serverPort, () => {
  logger.custLog('SystemLiar All green.');
});

function filterRooms(rooms) {
  return rooms.map(room => {
    return {
      id: room.id,
      number: room.number,
      name: room.name,
      subject: room.subject,
      members: room.members,
      limit: room.limit,
      ready: room.ready,
      status: room.status
    }
  })
}

function deepCopy(data) {
  return JSON.parse(JSON.stringify(data));
}

/**
 * 선택된 방을 찾음
 * */
function getSelectedRoom(rooms, id) {
  const checkRoom = rooms.filter(element => {
    return element.id + '' === id + '';
  });
  let selectedRoom = {};
  if (checkRoom.length) {
    selectedRoom = checkRoom[0];
  }
  return selectedRoom;
}
