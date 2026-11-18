import { assert } from './errors.js';
import { object } from './protocol.js';
import type { ModelProfiles } from './workflow/types.js';

export interface Settings { profiles: ModelProfiles; maxConcurrency: number }
export const defaultSettings: Settings = {
  profiles:{planner:{thinkingLevel:'auto'},worker:{thinkingLevel:'auto'},reviewer:{thinkingLevel:'auto'},integrator:{thinkingLevel:'auto'}},maxConcurrency:2,
};
export function parseSettings(value: unknown): Settings {
  const s=object(value);assert(Object.keys(s).every(k=>['profiles','maxConcurrency'].includes(k)),'unknown_setting');
  assert(Number.isSafeInteger(s.maxConcurrency)&&Number(s.maxConcurrency)>=1&&Number(s.maxConcurrency)<=8,'invalid_concurrency');
  const p=object(s.profiles);
  const profile=(v:unknown)=>{
    const x=object(v);assert(Object.keys(x).every(k=>['provider','model','thinkingLevel'].includes(k)),'unknown_model_setting');
    assert((x.provider===undefined)===(x.model===undefined),'model_requires_provider');
    if(x.provider!==undefined)assert(typeof x.provider==='string'&&x.provider.length>0&&x.provider.length<160&&typeof x.model==='string'&&x.model.length>0&&x.model.length<256,'invalid_model');
    assert(x.thinkingLevel===undefined||['off','minimal','low','medium','high','xhigh','max','auto','inherit'].includes(String(x.thinkingLevel)),'invalid_thinking_level');
  };
  for(const[k,v]of Object.entries(p)) {
    assert(['planner','worker','reviewer','integrator','complexity'].includes(k),'invalid_role');
    if(k==='complexity')for(const[c,vv]of Object.entries(object(v))){assert(['simple','standard','complex'].includes(c),'invalid_complexity');profile(vv);}
    else profile(v);
  }
  return structuredClone(s) as unknown as Settings;
}
