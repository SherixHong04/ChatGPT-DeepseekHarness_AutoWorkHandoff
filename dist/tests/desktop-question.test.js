import test from 'node:test';
import assert from 'node:assert/strict';
import { validDesktopReply } from '../src/desktop-question.js';
import { desktopHandoffPrompt } from '../src/desktop-question.js';
import { EventEmitter } from 'node:events';
test('desktop timeout needs an actually shown matching window and 30 seconds of interactive display', () => {
    const offer = { requestId: 'owned' };
    const row = { requestId: 'owned', kind: 'answer', answer: 'timeout', shownAt: 1000, visibleMs: 30_000 };
    assert(validDesktopReply(row, offer, 1000));
    assert(!validDesktopReply(row, offer, null));
    assert(!validDesktopReply({ ...row, visibleMs: 29_999 }, offer, 1000));
    assert(!validDesktopReply({ ...row, requestId: 'foreign' }, offer, 1000));
    assert(!validDesktopReply({ ...row, shownAt: 2000 }, offer, 1000));
    assert(validDesktopReply({ ...row, answer: 'decline', visibleMs: 0 }, offer, 1000));
    assert(validDesktopReply({ ...row, answer: 'cancelled', visibleMs: 0 }, offer, 1000));
});
test('the interactive desktop helper cannot inherit SW_HIDE and carries UTF-8 choices through its actual adapter', { skip: process.platform !== 'win32' }, async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => { child.emit('close', 0); return true; };
    child.stdin.end = (data) => {
        if (!data)
            return;
        assert(data.endsWith('\n'));
        const request = JSON.parse(data);
        assert.equal(request.title, '中文桌面测试');
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from(JSON.stringify({ kind: 'shown', requestId: request.requestId, shownAt: 1000, interactive: true }) + '\n'
                + JSON.stringify({ kind: 'answer', requestId: request.requestId, shownAt: 1000, visibleMs: 100, answer: 'decline' }) + '\n'));
        });
    };
    const launch = ((_command, args, options) => {
        assert.equal(options.windowsHide, false, 'Visible question must not use the background-helper hidden startup mode');
        assert.equal(options.shell, false);
        assert(args.includes('-File'));
        assert(!args.some(a => /bypass/i.test(a)));
        return child;
    });
    const answer = await desktopHandoffPrompt(undefined, launch)({ requestId: 'owned-question', title: '中文桌面测试' });
    assert.deepEqual(answer, { answer: 'decline', displayedAt: 1000, visibleMs: 100, transport: 'windows-desktop' });
});
//# sourceMappingURL=desktop-question.test.js.map