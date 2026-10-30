'use strict';
const {createReviewCore}=require('../../../../packages/review-core/index.cjs');
const PizZip=require('pizzip');
const Docxtemplater=require('docxtemplater');
const temml=require('temml');
const mathml2omml=require('mathml2omml');
const {DOMParser}=require('@xmldom/xmldom');
/** Imported only for an explicit Word export. Asset resolution is supplied by
 * the account/version validator; no path or URL becomes an IO operation here. */
function createMobileWordCore(readFigure){
 return createReviewCore({PizZip,Docxtemplater,temml,mathml2omml,DOMParser,binaryType:'uint8array',readFigure,warn:()=>{}});
}
module.exports={createMobileWordCore};
