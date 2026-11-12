import { dws } from './messagingDingtalk';

function failed(value:any):boolean {
    return value===false||!!(value&&(value.error||value.isError===true||value.success===false||value.partial||value.failedCount||value.failures?.length));
}

/** Explicit user read acknowledgement, scoped to one verified conversation. */
export async function clearDingtalkRedPoint(root:string,profile:string,conversation:string,peer:string,check:()=>void,call=dws) {
    check();
    const status=await call(['event','status','--profile',profile,'-f','json'],root);
    if(failed(status))throw Error('无法确认钉钉账号，请检查登录后重试');
    const identity=status.identity;
    if(!identity?.corp_id||!identity.user_id||`${identity.corp_id}:${identity.user_id}`!==profile)throw Error('DWS identity does not match configured profile');
    check();
    let remote=conversation;
    if(peer){
        const response=await call(['chat','+conversation-info','--open-dingtalk-id',peer,'--profile',profile,'-f','json'],root);
        const data=response.result??response.data??response;
        const info=data.conversationInfo;
        if(failed(response)||failed(data)||info?.singleChat!==true||typeof info.openConversationId!=='string'||!info.openConversationId||
            (conversation!==peer&&info.openConversationId!==conversation))throw Error('无法确认钉钉单聊会话，请重新同步消息后重试');
        remote=info.openConversationId;
    }
    check();
    const response=await call(['chat','clear-red-point','--conversation-id',remote,'--profile',profile,'-f','json'],root);
    const data=response.result??response.data??response;
    if(failed(response)||failed(data)||
        !(response.success===true||data?.success===true||data===true))throw Error('钉钉红点同步结果未确认，请重试');
}
