import test from 'node:test';
import assert from 'node:assert/strict';
import {validDesktopReply} from '../src/desktop-question.js';
import type {HandoffConsentRecord} from '../src/handoff-consent.js';
test('desktop timeout needs an actually shown matching window and 30 seconds of interactive display',()=>{
  const offer={requestId:'owned'} as HandoffConsentRecord;
  const row={requestId:'owned',kind:'answer',answer:'timeout',shownAt:1000,visibleMs:30_000};
  assert(validDesktopReply(row,offer,1000));
  assert(!validDesktopReply(row,offer,null));
  assert(!validDesktopReply({...row,visibleMs:29_999},offer,1000));
  assert(!validDesktopReply({...row,requestId:'foreign'},offer,1000));
  assert(!validDesktopReply({...row,shownAt:2000},offer,1000));
  assert(validDesktopReply({...row,answer:'decline',visibleMs:0},offer,1000));
  assert(validDesktopReply({...row,answer:'cancelled',visibleMs:0},offer,1000));
});
