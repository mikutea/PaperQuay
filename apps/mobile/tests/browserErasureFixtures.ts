export function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
type Pending={name:string;client:string;mode:LockMode;grant():void;abort():void};
export class LockHub {
  queue:Pending[]=[];held:Pending[]=[];
  port(client:string):Pick<LockManager,'request'> {
    return {request:(name:string,options:LockOptions,callback:(lock:Lock)=>unknown)=>this.request(client,name,options,callback)} as Pick<LockManager,'request'>;
  }
  private drain(){
    for(const item of [...this.queue]){
      if(this.queue.some(other=>other.name===item.name&&this.queue.indexOf(other)<this.queue.indexOf(item)))continue;
      const held=this.held.filter(other=>other.name===item.name);
      if(held.some(other=>other.mode==='exclusive')||item.mode==='exclusive'&&held.length)continue;
      item.grant();
    }
  }
  request(client:string,name:string,options:LockOptions,callback:(lock:Lock)=>unknown):Promise<unknown>{
    return new Promise((resolve,reject)=>{
      let granted=false;
      const item:Pending={name,client,mode:options.mode??'exclusive',grant:()=>{
        granted=true;this.queue=this.queue.filter(other=>other!==item);this.held.push(item);options.signal?.removeEventListener('abort',item.abort);
        const release=()=>{this.held=this.held.filter(other=>other!==item);this.drain();};
        Promise.resolve().then(()=>callback({name,mode:item.mode})).then(value=>{release();resolve(value);},error=>{release();reject(error);});
      },abort:()=>{if(granted)return;this.queue=this.queue.filter(other=>other!==item);reject(new DOMException('Aborted','AbortError'));this.drain();}};
      if(options.signal?.aborted){item.abort();return;}
      options.signal?.addEventListener('abort',item.abort,{once:true});this.queue.push(item);this.drain();
    });
  }
}
export class StorageHub {
  values=new Map<string,string>();
  ports:{notify(key:string|null):void}[]=[];
  port(){
    const listeners=new Set<(key:string|null)=>void>(),buffer:(string|null)[]=[];
    let paused=false,failed=false;
    const port={
      storage:{getItem:(key:string)=>this.values.get(key)??null,setItem:(key:string,value:string)=>{
        if(failed)throw Error('Synthetic storage failure');this.values.set(key,value);
        for(const other of this.ports)if(other!==port)queueMicrotask(()=>other.notify(key));
      },removeItem:(key:string)=>{if(!this.values.delete(key))return;for(const other of this.ports)if(other!==port)queueMicrotask(()=>other.notify(key));},
      get length(){return hub.values.size;},key:(index:number)=>[...this.values.keys()][index]??null},
      listen:(listener:(key:string|null)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},
      notify:(key:string|null)=>{if(paused)buffer.push(key);else for(const listener of listeners)listener(key);},
      pause:()=>{paused=true;},resume:()=>{paused=false;for(const key of buffer.splice(0))for(const listener of listeners)listener(key);},
      fail:()=>{failed=true;},
    };
    const hub=this;this.ports.push(port);return port;
  }
}
