const getSelectedRoom = require('../../modules/getSelectedRoom');

module.exports = function (responseData) {
  const { socket, ChatSocketIO } = this;
  const userInfo = userSession.userinfo;
  const roomId = userInfo.room;

  try {
    let selectedRoom = getSelectedRoom(rooms, roomId);
    const playersLength = selectedRoom.playingMembers.length;
    const targetNumber = Math.floor(Math.random() * playersLength);
    const nextOrder = selectedRoom.playingMembers[targetNumber];
    selectedRoom.playingMembers.splice(targetNumber, 1);

    if (responseData.hasOwnProperty("explain")) {
      if (playersLength > 0) {
        const serviceData = { nextPlayer: nextOrder, explain : responseData.explain, explaingPlayer: responseData.explaingPlayer };
        ChatSocketIO.to(roomId).emit("explain:game", serviceData);
      } else {
        ChatSocketIO.to(roomId).emit("discuss:game", { explain: responseData.explain, explaingPlayer: responseData.explaingPlayer });
      }
    }
  } catch (e) {

  }
};
