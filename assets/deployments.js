// Renders contract addresses from /deployments.json into [data-addr] elements. No external requests.
(function(){
  var root=document.body.getAttribute('data-root')||'';
  fetch(root+'deployments.json').then(function(r){return r.json()}).then(function(d){
    document.querySelectorAll('[data-addr]').forEach(function(el){
      var v=el.getAttribute('data-addr').split('.').reduce(function(o,k){return o&&o[k]},d);
      if(typeof v!=='string'){v='TBD_AFTER_DEPLOY'}
      el.textContent=v; if(v.indexOf('TBD')===0){el.classList.add('tbd');el.title='Not deployed yet'}
      else if(/^0x[0-9a-fA-F]{40}$/.test(v)&&d.network&&d.network.explorer&&el.tagName==='CODE'&&el.classList.contains('addr')){
        var a=document.createElement('a');a.href=d.network.explorer+'/address/'+v;a.textContent=v;el.textContent='';el.appendChild(a)}
    });
  }).catch(function(){document.querySelectorAll('[data-addr]').forEach(function(el){el.textContent='(could not load deployments.json)'})});
})();
