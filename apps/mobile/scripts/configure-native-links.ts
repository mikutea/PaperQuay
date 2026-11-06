import {parseArgs} from 'node:util';
import {prepareNativeLinks,readNativeInput} from './native-link-build.ts';

try{
    const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},platform:{type:'string'}}});
    if(!values.input||!values.output||!values.platform)throw Error('NATIVE_ARGUMENTS_REQUIRED');
    const settings=prepareNativeLinks(readNativeInput(values.input),values.platform,values.output);
    console.log(JSON.stringify({status:'prepared',platform:settings.platform,nativeClientsEnabled:false,signatureVerified:false,osDomainAssociationVerified:false}));
}catch{
  console.error('NATIVE_LINK_PREPARATION_FAILED');process.exitCode=1;
}
