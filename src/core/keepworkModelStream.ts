/** Consume one Keepwork SSE response. Never execute tools or retry a request here. */
export async function readKeepworkModelStream(response:Response, signal?:AbortSignal, observe?:(summary:{frames:number;toolDeltaFrames:number;finalizedToolCalls:number;completed:boolean})=>void, onText?:(text:string)=>void) {
    if (!response.body) throw Error('Keepwork model stream has no body');
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let buffer='',text='',bytes=0,finished=false,toolFinish=false;
    let calls:any[]=[];
    let frames=0,toolDeltaFrames=0;
    const aborted=()=>{if(signal?.aborted)throw Object.assign(Error('AI_GENERATION_ABORTED'),{name:'AbortError'});};
    const cancel=()=>{void reader.cancel().catch(()=>{});};
    signal?.addEventListener('abort',cancel,{once:true});
    function frame(raw:string) {
        const data=raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
        if(!data)return;
        if(data.trim()==='[DONE]'){finished=true;return;}
        let event:any;try{event=JSON.parse(data);}catch{throw Error('Invalid Keepwork model stream frame');}
        if(!event || typeof event!=='object' || event.error)throw Error('Keepwork model stream returned an error');
        frames++;
        const choice=event.choices?.[0],reason=event.stop_reason??choice?.finish_reason;
        if ([event.tool_calls_delta,choice?.delta?.tool_calls,choice?.message?.tool_calls].some(value=>Array.isArray(value)&&value.length>0)) toolDeltaFrames++;
        if(reason==='length'||reason==='content_filter')throw Error('Keepwork model stream incomplete; execution skipped');
        const content=event.result??choice?.delta?.content??'';
        if(typeof content==='string' && content){text+=content;onText?.(visibleModelText(text));}
        // The service sends argument deltas for progress, then a complete tool_calls snapshot.
        // Only that final snapshot may leave this transport; partial arguments are never executed.
        if(event.tool_calls!==undefined){if(!Array.isArray(event.tool_calls))throw Error('Invalid finalized tool calls');calls=event.tool_calls;}
        if(reason==='tool_calls')toolFinish=true;
        if(reason==='stop'||reason==='tool_calls'||event.is_end===true)finished=true;
    }
    try {
        aborted();
        while(true){
            const chunk=await reader.read();aborted();
            if(chunk.done)break;
            bytes+=chunk.value.byteLength;if(bytes>8*1024*1024)throw Error('Keepwork model stream exceeds limit');
            buffer+=decoder.decode(chunk.value,{stream:true});
            // Normalize CRLF only after concatenation, including chunk-split delimiters.
            buffer=buffer.replace(/\r\n/g,'\n');
            let boundary:number;
            while((boundary=buffer.indexOf('\n\n'))!==-1){frame(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}
            if(buffer.length>2*1024*1024)throw Error('Keepwork model stream frame exceeds limit');
        }
        buffer+=decoder.decode();
        if(buffer.trim())throw Error('Keepwork model stream ended inside a frame; execution skipped');
        if(!finished)throw Error('Keepwork model stream ended without completion; execution skipped');
        if((toolFinish||toolDeltaFrames>0)&&!calls.length)throw Error('Keepwork model omitted finalized tool calls; execution skipped');
        return {result:text,tool_calls:calls};
    } finally {signal?.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});reader.releaseLock();observe?.({frames,toolDeltaFrames,finalizedToolCalls:calls.length,completed:finished});}
}

/** DSML is an internal tool envelope, including when its opening tag spans frames. */
export function visibleModelText(text:string) {
    let end=text.length;
    for(const marker of ['<｜｜DSML｜｜','</｜｜DSML｜｜']){
        const start=text.indexOf(marker);if(start>=0)end=Math.min(end,start);
        for(let size=Math.min(marker.length-1,text.length);size>0;size--)
            if(text.endsWith(marker.slice(0,size))){end=Math.min(end,text.length-size);break;}
    }
    return text.slice(0,end);
}
