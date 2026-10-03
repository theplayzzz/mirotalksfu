'use strict';

require('should');

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const policyPath = path.join(__dirname, '..', 'app', 'src', 'SingleRoomPolicy.js');

// The policy reads the environment when it is loaded, so every case runs in its own process.
function run(env, code) {
    const output = execFileSync(process.execPath, ['-e', `const p = require(${JSON.stringify(policyPath)}); ${code}`], {
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
}

function failure(env) {
    try {
        run(env, 'console.log(1)');
    } catch (error) {
        return String(error.stderr || error.message);
    }
    return null;
}

const production = { SINGLE_ROOM_ID: 'link', SINGLE_ROOM_PASSWORD: 'correct horse battery' };
const development = {
    ...production,
    APP_ENV: 'dev',
    DEV_TEST_ROOM_ID: 'teste',
    DEV_TEST_ROOM_KEY: 'k'.repeat(40),
};

describe('test-SingleRoomPolicy', () => {
    describe('production (no test room)', () => {
        it('allows only the single room and checks its password', () => {
            const r = run(
                production,
                `console.log(JSON.stringify({
                    enabled: p.enabled,
                    link: p.allows('link'),
                    other: p.allows('outra'),
                    teste: p.allows('teste'),
                    ok: p.matches('correct horse battery'),
                    okForLink: p.matches('correct horse battery', 'link'),
                    wrong: p.matches('wrong password'),
                    notString: p.matches(undefined),
                    prefix: p.matches('correct horse'),
                    passwordFor: p.passwordFor('link'),
                }))`
            );

            r.enabled.should.be.true();
            r.link.should.be.true();
            r.other.should.be.false();
            r.teste.should.be.false();
            r.ok.should.be.true();
            r.okForLink.should.be.true();
            r.wrong.should.be.false();
            r.notString.should.be.false();
            r.prefix.should.be.false();
            r.passwordFor.should.equal('correct horse battery');
        });

        it('has no test room and cannot mint a token', () => {
            const r = run(
                production,
                `let error = ''; try { p.mintTestToken(); } catch (e) { error = e.message; }
                 console.log(JSON.stringify({ testRoomId: p.testRoomId, error }))`
            );

            r.testRoomId.should.equal('');
            r.error.should.match(/not enabled/);
        });

        it('allows every room when no single room is configured', () => {
            const r = run({}, `console.log(JSON.stringify({ enabled: p.enabled, any: p.allows('qualquer') }))`);

            r.enabled.should.be.false();
            r.any.should.be.true();
        });
    });

    describe('test room refuses to exist outside development', () => {
        it('fails to start without APP_ENV=dev', () => {
            failure({ ...production, DEV_TEST_ROOM_ID: 'teste', DEV_TEST_ROOM_KEY: 'k'.repeat(40) }).should.match(
                /only allowed when APP_ENV=dev/
            );
            failure({
                ...production,
                APP_ENV: 'production',
                DEV_TEST_ROOM_ID: 'teste',
                DEV_TEST_ROOM_KEY: 'k'.repeat(40),
            }).should.match(/only allowed when APP_ENV=dev/);
        });

        it('fails to start with a weak key, a bad id or no single room', () => {
            failure({ ...development, DEV_TEST_ROOM_KEY: 'short' }).should.match(/at least 32 characters/);
            failure({ ...development, DEV_TEST_ROOM_ID: 'link' }).should.match(/different from SINGLE_ROOM_ID/);
            failure({ ...development, DEV_TEST_ROOM_ID: 'bad id!' }).should.match(/valid room ID/);
            failure({ APP_ENV: 'dev', DEV_TEST_ROOM_ID: 'teste', DEV_TEST_ROOM_KEY: 'k'.repeat(40) }).should.match(
                /requires SINGLE_ROOM_ID/
            );
        });
    });

    describe('test room in development', () => {
        it('opens with a minted token and not with the room password', () => {
            const r = run(
                development,
                `const token = p.mintTestToken(600);
                 console.log(JSON.stringify({
                    allowsTeste: p.allows('teste'),
                    allowsLink: p.allows('link'),
                    allowsOther: p.allows('outra'),
                    token: p.matches(token, 'teste'),
                    tokenOnLink: p.matches(token, 'link'),
                    passwordOnTeste: p.matches('correct horse battery', 'teste'),
                    passwordOnLink: p.matches('correct horse battery', 'link'),
                    linkDefault: p.matches('correct horse battery'),
                    internalIsNotThePassword: p.passwordFor('teste') !== 'correct horse battery' && p.passwordFor('teste').length >= 32,
                    linkPassword: p.passwordFor('link'),
                 }))`
            );

            r.allowsTeste.should.be.true();
            r.allowsLink.should.be.true();
            r.allowsOther.should.be.false();
            r.token.should.be.true();
            r.tokenOnLink.should.be.false();
            r.passwordOnTeste.should.be.false();
            r.passwordOnLink.should.be.true();
            r.linkDefault.should.be.true();
            r.internalIsNotThePassword.should.be.true();
            r.linkPassword.should.equal('correct horse battery');
        });

        it('rejects tampered, malformed and expired tokens', () => {
            const r = run(
                development,
                `const token = p.mintTestToken(600);
                 const [exp, sig] = token.split('.');
                 const realNow = Date.now;
                 Date.now = () => realNow() - 3 * 60 * 60 * 1000;
                 const old = p.mintTestToken(60);
                 Date.now = realNow;
                 const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
                 console.log(JSON.stringify({
                    valid: p.matches(token, 'teste'),
                    expired: p.matches(old, 'teste'),
                    laterExpiry: p.matches((Number(exp) + 3600) + '.' + sig, 'teste'),
                    flipped: p.matches(exp + '.' + flipped, 'teste'),
                    empty: p.matches('', 'teste'),
                    undef: p.matches(undefined, 'teste'),
                    noDot: p.matches(exp, 'teste'),
                    extra: p.matches(token + '.x', 'teste'),
                    shortExp: p.matches('123.' + sig, 'teste'),
                 }))`
            );

            r.valid.should.be.true();
            for (const name of ['expired', 'laterExpiry', 'flipped', 'empty', 'undef', 'noDot', 'extra', 'shortExp']) {
                r[name].should.be.false(`${name} must be rejected`);
            }
        });

        it('keeps the token lifetime between one second and one day', () => {
            const r = run(
                development,
                `const now = Math.floor(Date.now() / 1000);
                 const life = (t) => Number(t.split('.')[0]) - now;
                 console.log(JSON.stringify({ min: life(p.mintTestToken(-5)), max: life(p.mintTestToken(10 * 86400)), def: life(p.mintTestToken()) }))`
            );

            r.min.should.be.within(1, 3);
            r.max.should.be.within(86398, 86402);
            r.def.should.be.within(7198, 7202);
        });

        it('rejects a token made with another key', () => {
            const token = run(development, 'console.log(JSON.stringify(p.mintTestToken(600)))');
            const other = run(
                { ...development, DEV_TEST_ROOM_KEY: 'z'.repeat(40) },
                `console.log(JSON.stringify(p.matches(${JSON.stringify(token)}, 'teste')))`
            );

            other.should.be.false();
        });
    });

    describe('deployment files', () => {
        // The production deployment must never mention the development test room.
        const root = path.join(__dirname, '..');
        const candidates = [];
        const ops = path.join(root, 'ops');
        if (fs.existsSync(ops)) {
            for (const name of fs.readdirSync(ops)) {
                if (/prod/i.test(name)) candidates.push(path.join(ops, name));
            }
        }
        for (const name of ['compose.yaml', 'compose.prod.yaml']) {
            if (fs.existsSync(path.join(root, name))) candidates.push(path.join(root, name));
        }

        it('keeps DEV_TEST_ROOM and APP_ENV=dev out of the production files', () => {
            for (const file of candidates) {
                const text = fs.readFileSync(file, 'utf8');
                text.should.not.match(/DEV_TEST_ROOM/, path.relative(root, file));
                text.should.not.match(/APP_ENV\s*[:=]\s*["']?dev/, path.relative(root, file));
            }
        });
    });
});
