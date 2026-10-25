import assert from 'node:assert/strict';
import { explainCall, askCallQuestion, getSilenceSuggestions, storeTranscriptUtterance } from './src/services/api.ts';
const transcript = [{speakerId:'sam',speakerName:'Sam',text:'Meet at seven.',startMs:1,endMs:2,id:'1',timestamp:new Date()}];
const base = {callId:'test',userId:'me',transcript,atMs:2};
globalThis.fetch = async () => { throw new Error('offline'); };
await assert.rejects(explainCall(base), /Could not reach/);
await assert.rejects(askCallQuestion({...base,question:'When?'}), /Could not reach/);
assert.deepEqual(await getSilenceSuggestions({...base,silenceDurationMs:45000}), []);
globalThis.fetch = async () => ({ok:true,json:async()=>({stored:false})});
await assert.rejects(storeTranscriptUtterance({...transcript[0],callId:'test'}), /could not be saved/);
globalThis.fetch = async (_url, options) => {
 const body=JSON.parse(options.body);
 assert.equal(body.recent_transcript[0].speaker_id,'sam');
 assert.equal(body.recent_transcript[0].text,'Meet at seven.');
 return {ok:true,json:async()=>({answer:'Meet at seven.',confidence:0})};
};
assert.equal((await explainCall(base)).answer,'Meet at seven.');
console.log('PASS: 5 API client checks; no network or paid model calls.');
