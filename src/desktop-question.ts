import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HandoffConsentRecord, HandoffPrompt } from './handoff-consent.js';

export function desktopQuestionAvailable(): boolean {
  return process.platform === 'win32' && existsSync(path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'));
}
export function validDesktopReply(row: any, offer: HandoffConsentRecord, shownAt: number | null): boolean {
  return row?.requestId === offer.requestId && row?.kind === 'answer' && shownAt !== null && row.shownAt === shownAt
    && Number.isSafeInteger(row.visibleMs) && row.visibleMs >= 0
    && ['handoff','decline','cancelled','timeout'].includes(row.answer)
    && (row.answer !== 'timeout' || row.visibleMs >= 30_000);
}
/** Own user-facing app window; never changes the host's approval or security policy. */
export function desktopHandoffPrompt(diagnose?: (event: string) => void, launch: typeof spawn = spawn): HandoffPrompt {
  return async (offer, signal) => {
    if (!desktopQuestionAvailable() || signal?.aborted) return 'unavailable';
    return new Promise(resolve => {
      const helper=fileURLToPath(new URL('../../scripts/desktop-question.ps1',import.meta.url));
      diagnose?.(helper);
      const child=launch(path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        // This is the user-requested interactive window, so SW_HIDE must not be inherited.
        ['-NoProfile','-STA','-File',helper],{windowsHide:false,stdio:['pipe','pipe','pipe'],shell:false});
      let done=false,pending='',shownAt:number|null=null;
      const finish=(answer: Parameters<typeof resolve>[0])=>{
        if(done)return;done=true;clearTimeout(watchdog);signal?.removeEventListener('abort',abort);
        child.stdin?.end();child.kill();resolve(answer);
      };
      const abort=()=>finish('unavailable');
      // Bound a blocked/locked helper below the normal MCP tool timeout. No hidden timeout approval.
      const watchdog=setTimeout(()=>finish('unavailable'),55_000);
      signal?.addEventListener('abort',abort,{once:true});
      child.on('error',e=>{diagnose?.(e.message);finish('unavailable');});child.on('close',code=>{diagnose?.('exit '+code);finish('unavailable');});
      child.stderr?.on('data',bytes=>diagnose?.(bytes.toString()));
      child.stdout?.on('data',bytes=>{
        pending+=bytes.toString('utf8');if(pending.length>16_384){finish('unavailable');return;}
        let split;while((split=pending.indexOf('\n'))>=0){const line=pending.slice(0,split);pending=pending.slice(split+1);
          let row;try{row=JSON.parse(line);}catch{continue;}
          if(row.requestId!==offer.requestId)continue;
          if(row.kind==='shown'&&Number.isSafeInteger(row.shownAt)&&row.interactive===true)shownAt=row.shownAt;
          if(validDesktopReply(row,offer,shownAt))finish({answer:row.answer,displayedAt:shownAt!,visibleMs:row.visibleMs,transport:'windows-desktop'});
        }
      });
      child.stdin?.on('error',()=>finish('unavailable'));
      child.stdin?.end(JSON.stringify({requestId:offer.requestId,title:offer.title})+'\n');
    });
  };
}
