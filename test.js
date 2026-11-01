// local test: CHROME_PATH=/path/to/chrome node test.js
const fs=require('fs');const {renderPdf}=require('./lib/render');
(async()=>{for(const [n,a] of [['eligible',{first:'Ali',last:'G',balance:650000,rate:6.2,repay:3982,offset:20000,savings:40000,value:1100000,income:300000,deps:'2',debts:0}],['info',{first:'Sam',last:'Lee',balance:650000,rate:6.2,repay:3982,offset:20000,savings:40000,value:700000,income:300000,deps:'2',debts:0}]]){
const r=await renderPdf(a);fs.writeFileSync('test-'+n+'.pdf',r.pdf);console.log(n,r.eligible,r.pdf.length);}})();
