const{createHash,randomUUID}=require('node:crypto');
module.exports=require('../../packages/radar-core/index.cjs').createRadarCore({hash:value=>createHash('sha256').update(value).digest('hex').slice(0,24),randomUUID});
