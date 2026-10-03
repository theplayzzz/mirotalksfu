'use strict';

require('should');

const jwt = require('jsonwebtoken');
const { ReplayAccess, COOKIE_NAME } = require('../../app/src/replay/ReplayAccess');

const SECRET = 'a-secret-that-is-not-the-default-one';

describe('test-sfu-access (who may open the replay gallery)', () => {
    const make = (overrides = {}) => new ReplayAccess({ secret: SECRET, roomPassword: 'room-pass', ...overrides });

    it('refuses to work with the default JWT secret or none', () => {
        (() => make({ secret: 'mirotalksfu_jwt_secret' })).should.throw(/own/);
        (() => make({ secret: '' })).should.throw();
    });

    describe('tickets', () => {
        it('are good once', () => {
            const access = make();
            const { ticket } = access.issueTicket();
            access.consumeTicket(ticket).should.be.true();
            access.consumeTicket(ticket).should.be.false();
        });

        it('expire after a minute', () => {
            let now = 1_000_000;
            const access = make({ now: () => now });
            const { ticket, expiresAt } = access.issueTicket();
            expiresAt.should.equal(now + 60_000);
            now += 60_001;
            access.consumeTicket(ticket).should.be.false();
        });

        it('cannot be guessed or faked', () => {
            const access = make();
            access.consumeTicket('nope').should.be.false();
            access.consumeTicket(undefined).should.be.false();
            access.consumeTicket({ ticket: 'x' }).should.be.false();
            access.consumeTicket('x'.repeat(1000)).should.be.false();
        });

        it('are different every time and the store stays small', () => {
            const access = make();
            const first = access.issueTicket().ticket;
            access.issueTicket().ticket.should.not.equal(first);
            for (let i = 0; i < 3000; i++) access.issueTicket();
            access.tickets.size.should.be.belowOrEqual(2000);
        });
    });

    describe('the cookie', () => {
        it('is accepted, and read from the cookie header among others', () => {
            const access = make();
            const token = access.signAccess();
            access.verifyAccess(token).should.be.true();
            const req = { headers: { cookie: `a=1; ${COOKIE_NAME}=${token}; b=2` } };
            access.tokenFromRequest(req).should.equal(token);
            access.isAllowed(req).should.be.true();
            access.isAllowed({ headers: {} }).should.be.false();
            access.isAllowed({ headers: { cookie: `${COOKIE_NAME}=garbage` } }).should.be.false();
        });

        it('has its own scope: another token of the app signed with the same secret is not an access cookie', () => {
            const access = make();
            const other = jwt.sign({ scope: 'rec-upload', roomId: 'link' }, SECRET);
            access.verifyAccess(other).should.be.false();
            // and a token of the right scope signed with the app secret itself (not the derived key) is not accepted either
            access.verifyAccess(jwt.sign({ scope: 'replay-view', pv: access.passwordVersion }, SECRET)).should.be.false();
        });

        it('stops working when the room password changes', () => {
            const token = make().signAccess();
            make().verifyAccess(token).should.be.true();
            make({ roomPassword: 'changed' }).verifyAccess(token).should.be.false();
        });

        it('stops working when the server secret changes', () => {
            const token = make().signAccess();
            make({ secret: 'another-secret-entirely-different' }).verifyAccess(token).should.be.false();
        });

        it('rejects a token that says it needs no signature', () => {
            const access = make();
            const unsigned = jwt.sign({ scope: 'replay-view', pv: access.passwordVersion }, '', { algorithm: 'none' });
            access.verifyAccess(unsigned).should.be.false();
        });

        it('is set HttpOnly, SameSite, on the gallery path only, and Secure over https', () => {
            const access = make();
            const header = access.cookieHeader('abc', { secure: true });
            header.should.startWith(`${COOKIE_NAME}=abc;`);
            header.should.containEql('HttpOnly').and.containEql('Secure').and.containEql('SameSite=Lax').and.containEql('Path=/replay/');
            header.should.containEql('Max-Age=2592000');
            access.cookieHeader('abc', { secure: false }).should.not.containEql('Secure');
        });
    });

    describe('who saved a clip and whose screen it was', () => {
        it('is an HMAC of the uuid: stable, different per person, never the uuid', () => {
            const access = make();
            const a = access.hashPeer('uuid-a');
            a.should.equal(access.hashPeer('uuid-a'));
            a.should.not.equal(access.hashPeer('uuid-b'));
            a.should.not.containEql('uuid-a');
            access.hashPeer('').should.equal('');
            access.hashPeer(undefined).should.equal('');
        });

        it('lets the person who saved it and the sharer delete it, nobody else', () => {
            const access = make();
            const clip = { id: 'c1', requestedByHash: access.hashPeer('saver'), sharerHash: access.hashPeer('sharer') };
            access.owns(clip, 'saver').should.be.true();
            access.owns(clip, 'sharer').should.be.true();
            access.owns(clip, 'someone-else').should.be.false();
            access.owns(clip, '').should.be.false();
            access.owns(clip, undefined).should.be.false();
            access.owns({ id: 'c2' }, 'saver').should.be.false();
        });

        it('are left out of what a browser sees, with `mine` instead', () => {
            const access = make();
            const clip = { id: 'c1', sharer: 'Beltrano', requestedByHash: access.hashPeer('saver'), sharerHash: access.hashPeer('sharer') };
            const seenBySaver = access.publicClip(clip, 'saver');
            seenBySaver.should.deepEqual({ id: 'c1', sharer: 'Beltrano', mine: true });
            access.publicClip(clip, 'other').mine.should.be.false();
            JSON.stringify(access.publicClip(clip, 'saver')).should.not.containEql('Hash');
        });
    });
});
