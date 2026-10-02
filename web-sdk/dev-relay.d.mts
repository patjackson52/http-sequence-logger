import type {IncomingMessage,ServerResponse} from 'node:http';
export function createNetworkLogRelay(options:{connectionFile?:string;origin:string;basePath?:string;timeoutMs?:number;fetchImpl?:typeof fetch;reachable?:boolean;authorize?:(req:IncomingMessage)=>string|null|Promise<string|null>}):(req:IncomingMessage,res:ServerResponse,next?:()=>void)=>Promise<void>;
