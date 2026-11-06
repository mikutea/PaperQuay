import {parseArgs} from 'node:util';
import {validateNativeBundle} from './native-link-build.ts';
try{
  const {values}=parseArgs({options:{platform:{type:'string'},host:{type:'string'},bundle:{type:'string'}}});
  if(!values.platform||!values.host||!values.bundle)throw Error('NATIVE_ARGUMENTS_REQUIRED');
  console.log(JSON.stringify({status:'NATIVE_BUNDLE_VALIDATED',...validateNativeBundle(values.platform,values.host,values.bundle)}));
}catch{console.error('NATIVE_BUNDLE_VALIDATION_FAILED');process.exitCode=1;}
