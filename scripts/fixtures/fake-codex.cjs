const readline=require('node:readline');
const lines=readline.createInterface({input:process.stdin});
let initialized=false;
function output(value){const text=JSON.stringify(value)+'\n';process.stdout.write(text.slice(0,5));process.stdout.write(text.slice(5));}
lines.on('line',line=>{
    const m=JSON.parse(line);
    if(m.method==='initialize') output({id:m.id,result:process.argv.includes('--incompatible')?{}:{userAgent:'fixture'}});
    else if(m.method==='initialized') initialized=true;
    else if(m.method==='model/list') output(initialized?{id:m.id,result:{data:[{id:'fixture'}]}}:{id:m.id,error:{message:'Handshake not completed'}});
    else if(m.method==='fixture/crash') process.exit(1);
    else if(m.method==='fixture/unicode') {
        const bytes=Buffer.from(JSON.stringify({id:m.id,result:{text:'中文任务\n检查日历 📅'}})+'\n');
        const split=bytes.indexOf(Buffer.from('中'))+1;
        process.stdout.write(bytes.subarray(0,split));
        setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);
    }
    else if(m.method==='fixture/request') {
        output({method:'fixture/notice',params:{text:'ok'}});
        output({id:900,method:'item/commandExecution/requestApproval',params:{command:'test'}});
        output({id:m.id,result:{}});
    }
});
