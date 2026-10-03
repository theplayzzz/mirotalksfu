'use strict';

require('should');

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const roomClientSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'RoomClient.js'), 'utf8');

describe('test-Reconnect', () => {
    let context;
    let getReconnectDirectJoinURL;

    // `room_password` is a global of public/js/Room.js: the password that came in the page URL, if any.
    before(() => {
        context = vm.createContext({
            window: { location: { origin: 'https://localhost:3010' } },
            room_password: false,
        });
        vm.runInContext(`${roomClientSource}; globalThis.RoomClientForTest = RoomClient;`, context);
        getReconnectDirectJoinURL = context.RoomClientForTest.prototype.getReconnectDirectJoinURL;
    });

    const makeClient = (RoomPassword) => ({
        room_id: 'test',
        RoomPassword,
        peer_name: 'Presenter',
        getPeerInfoFromLocalStorage: () => ({
            peer_presenter: true,
            peer_audio: false,
            peer_video: false,
            peer_screen: false,
            peer_token: 'signed-token',
        }),
    });

    it('does not include the stale client presenter flag in reconnect URLs', () => {
        context.room_password = false;

        const reconnectUrl = getReconnectDirectJoinURL.call(makeClient(false));

        reconnectUrl.includes('isPresenter').should.be.false();
        reconnectUrl.includes('token=signed-token').should.be.true();
        reconnectUrl.should.equal(
            'https://localhost:3010/join?room=test&name=Presenter&audio=false&video=false&screen=false&notify=0&token=signed-token'
        );
    });

    it('never writes the password typed in the join dialog into the reconnect URL', () => {
        context.room_password = false;

        const reconnectUrl = getReconnectDirectJoinURL.call(makeClient('typed-secret'));

        reconnectUrl.includes('typed-secret').should.be.false();
        reconnectUrl.includes('roomPassword').should.be.false();
    });

    it('keeps a room password that was already part of the page URL', () => {
        context.room_password = 'from-url';

        const reconnectUrl = getReconnectDirectJoinURL.call(makeClient(false));

        reconnectUrl.endsWith('&token=signed-token&roomPassword=from-url').should.be.true();
    });
});
