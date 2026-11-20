/* VOLUME / PATHS — real 3D graph & evolving resistance field.
   Node index: x + n*(y + n*z). Z is vertical. No adjacency list is stored. */
(() => {
  'use strict';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smooth = t => t*t*(3-2*t);
  const lerp = (a,b,t) => a+(b-a)*t;
  function hash3(x,y,z,seed) {
    let v = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ seed;
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  }
  function noise3(x,y,z,seed) {
    const a = Math.floor(x), b = Math.floor(y), c = Math.floor(z);
    const dx = smooth(x-a), dy = smooth(y-b), dz = smooth(z-c);
    const n000=hash3(a,b,c,seed), n100=hash3(a+1,b,c,seed),
          n010=hash3(a,b+1,c,seed), n110=hash3(a+1,b+1,c,seed),
          n001=hash3(a,b,c+1,seed), n101=hash3(a+1,b,c+1,seed),
          n011=hash3(a,b+1,c+1,seed), n111=hash3(a+1,b+1,c+1,seed);
    return lerp(lerp(lerp(n000,n100,dx),lerp(n010,n110,dx),dy),
                lerp(lerp(n001,n101,dx),lerp(n011,n111,dx),dy),dz);
  }
  function fbm(x,y,z,seed,frequency) {
    let v=0, sum=0, amplitude=1, f=frequency;
    for(let i=0;i<4;i++) {
      v+= noise3(x*f+17.2,y*f+9.9,z*f+33.3,seed+i*11011)*amplitude;
      sum+=amplitude; amplitude*=0.48; f*=2.07;
    }
    return v/sum;
  }
  function buildMoves(connectivity) {
    const moves=[];
    for(let dz=-1; dz<=1;dz++)for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(!dx&&!dy&&!dz)continue;
      const dims=Number(dx!==0)+Number(dy!==0)+Number(dz!==0);
      if(connectivity===6 && dims>1)continue;
      moves.push({dx,dy,dz,length:Math.hypot(dx,dy,dz), knight:false, type:dims===1?0:1});
    }
    if(connectivity===50){
      for(let ax=0;ax<3;ax++)for(let bx=0;bx<3;bx++){
        if(ax===bx) continue;
        for(const sa of [-1,1])for(const sb of [-1,1]){
          const q=[0,0,0];q[ax]=2*sa;q[bx]=sb;
          moves.push({dx:q[0],dy:q[1],dz:q[2],length:Math.sqrt(5),knight:true,type:2});
        }
      }
    }
    return moves;
  }
  class MinHeap {
    constructor(){this.ids=[];this.vals=[];this.size=0;}
    clear(){this.size=0;}
    push(id,val) {
      let k=this.size++; const ids=this.ids,v=this.vals;
      while(k>0){const p=(k-1)>>1;if(v[p]<=val)break;ids[k]=ids[p];v[k]=v[p];k=p;}
      ids[k]=id;v[k]=val;
    }
    pop(){
      const n=this.size,ids=this.ids,v=this.vals; if(!n)return -1;
      const first=ids[0],tail=ids[n-1],tailv=v[n-1];this.size=n-1;
      if(n>1){let k=0;while(true){let c=k*2+1;if(c>=n-1)break;
          if(c+1<n-1&&v[c+1]<v[c])c++;
          if(v[c]>=tailv)break;ids[k]=ids[c];v[k]=v[c];k=c;
        }ids[k]=tail;v[k]=tailv;
      }
      return first;
    }
  }
  class VolumeSimulation {
    constructor(opts={}) {
      this.n=opts.n||40; this.seed=opts.seed||733;
      this.roughness=opts.roughness??.65;this.barriers=opts.barriers??.18;
      this.connectivity=opts.connectivity||50;
      this.moves=buildMoves(this.connectivity);
      this.climb=opts.climb??2;this.learning=opts.learning??.8;this.hubBias=opts.hubBias??.65;
      this.fast=opts.fast!==false;
      this.count=this.n*this.n*this.n;
      this.base=new Float32Array(this.count);
      this.solid=new Uint8Array(this.count);
      this.traffic=new Float32Array(this.count);
      this.scratch=new Float32Array(this.count);
      this.g=new Float32Array(this.count);
      this.previous=new Int32Array(this.count);
      this.seen=new Uint32Array(this.count);
      this.closed=new Uint32Array(this.count);
      this.stamp=0;this.heap=new MinHeap();
      this.tripCount=0;this.attempts=0;this.lastVisited=0;this.lastCost=0;this.lastPath=null;
      this.generate();
    }
    index(x,y,z){return x+this.n*(y+this.n*z);}
    xyz(i){const n=this.n;return [i%n,Math.floor(i/n)%n,Math.floor(i/(n*n))];}
    xyzPosition(i){const [x,y,z]=this.xyz(i),fac=14/(this.n-1);return [(x-(this.n-1)/2)*fac,(y-(this.n-1)/2)*fac,(z-(this.n-1)/2)*fac];}
    generate(){
      const n=this.n,inv=1/(n-1),seed=this.seed, rough=this.roughness;
      const frequency=2.4+rough*2.9;
      let solids=0;let min=Infinity,max=-Infinity,mean=0;
      for(let z=0;z<n;z++) for(let y=0;y<n;y++)for(let x=0;x<n;x++){
        const i=this.index(x,y,z); const px=x*inv,py=y*inv,pz=z*inv;
        const a=fbm(px,py,pz,seed,frequency);
        const b=noise3(px*2.1+9.1,py*2.1+16.9,pz*2.1+3.6,seed+99);
        const signal=clamp(a*.76+b*.24,0,1);
        // Positive, continuous 3D permeability landscape. Rich high-resistance pockets.
        const resistance=.43+1.25*Math.pow(signal/.64,3.0)+.48*Math.abs(Math.sin(4.2*signal+5.1*pz));
        this.base[i]=resistance;
        // Solid geometry is genuinely volumetric, not a heightfield.
        const isSolid = signal>(.675-this.barriers*.27) && this.barriers>0.005;
        if(isSolid){this.solid[i]=1;solids++;}
        min=Math.min(min,resistance);max=Math.max(max,resistance);mean+=resistance;
      }
      this.solidCount=solids;this.minResistance=min;this.maxResistance=max;this.meanResistance=mean/this.count;
      this.traffic.fill(0);this.scratch.fill(0);this.tripCount=0;this.attempts=0;
      this.makeHubs();
    }
    makeHubs(){
      this.hubs=[];const n=this.n;
      for(let k=0;k<8;k++){
        let found=-1;
        for(let tries=0;tries<400;tries++){
          const i=this.index(Math.floor(Math.random()*n),Math.floor(Math.random()*n),Math.floor(Math.random()*n));
          if(this.solid[i])continue;
          const [x,y,z]=this.xyz(i);
          if(this.hubs.every(j=>{const [u,v,w]=this.xyz(j);return Math.hypot(x-u,y-v,z-w)>n*.28;})){found=i;break;}
        }
        if(found>=0)this.hubs.push(found);
      }
    }
    chooseFreeNear(hub,radius){
      const n=this.n; const [hx,hy,hz]=this.xyz(hub);
      for(let t=0;t<35;t++){
        const x=clamp(Math.round(hx+(Math.random()-.5)*radius),0,n-1);
        const y=clamp(Math.round(hy+(Math.random()-.5)*radius),0,n-1);
        const z=clamp(Math.round(hz+(Math.random()-.5)*radius),0,n-1);
        const i=this.index(x,y,z);if(!this.solid[i])return i;
      }
      return hub;
    }
    randomFree(){
      for(let t=0;t<200;t++){const i=Math.floor(Math.random()*this.count);if(!this.solid[i])return i;}
      return 0;
    }
    trip(){
      let a,b;const chooseHub=this.hubs.length>=2 && Math.random()<this.hubBias;
      if(chooseHub){
        const ai=Math.floor(Math.random()*this.hubs.length),bi=(ai+1+Math.floor(Math.random()*(this.hubs.length-1)))%this.hubs.length;
        a=this.chooseFreeNear(this.hubs[ai],Math.max(2,this.n*.08));
        b=this.chooseFreeNear(this.hubs[bi],Math.max(2,this.n*.08));
      } else {a=this.randomFree();b=this.randomFree();}
      const [ax,ay,az]=this.xyz(a),[bx,by,bz]=this.xyz(b);
      if(Math.hypot(ax-bx,ay-by,az-bz)<this.n*.25)b=this.randomFree();
      return [a,b];
    }
    setConnectivity(c){this.connectivity=c;this.moves=buildMoves(c);}
    // Continuous trilinear interpolation of the discretized 3D resistance field.
    // Essential for long 3D knight edges: endpoints alone can miss an expensive pocket.
    sampleResistance(x,y,z){
      const n=this.n,c=this.base;
      const x0=Math.floor(x),y0=Math.floor(y),z0=Math.floor(z);
      const x1=Math.min(n-1,x0+1),y1=Math.min(n-1,y0+1),z1=Math.min(n-1,z0+1);
      const fx=x-x0,fy=y-y0,fz=z-z0;
      const a=x0+n*(y0+n*z0),b=x1+n*(y0+n*z0),
            d=x0+n*(y1+n*z0),e=x1+n*(y1+n*z0),
            f=x0+n*(y0+n*z1),g=x1+n*(y0+n*z1),
            h=x0+n*(y1+n*z1),j=x1+n*(y1+n*z1);
      const q0=lerp(lerp(c[a],c[b],fx),lerp(c[d],c[e],fx),fy);
      const q1=lerp(lerp(c[f],c[g],fx),lerp(c[h],c[j],fx),fy);
      return lerp(q0,q1,fz);
    }
    // Candidate passes through sampled swept voxels: knight transitions cannot tunnel through solids.
    segmentClear(x,y,z,dx,dy,dz){
      const steps=Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz))*4;
      for(let s=1;s<steps;s++){
        const t=s/steps,ix=Math.round(x+dx*t),iy=Math.round(y+dy*t),iz=Math.round(z+dz*t);
        if(this.solid[this.index(ix,iy,iz)])return false;
      }
      return true;
    }
    findPath(start,target) {
      this.attempts++;
      if(start===target||this.solid[start]||this.solid[target])return null;
      let stamp=++this.stamp;
      if(stamp===0xffffffff){this.seen.fill(0);this.closed.fill(0);this.stamp=stamp=1;}
      const n=this.n, n2=n*n, base=this.base,traffic=this.traffic, solid=this.solid, seen=this.seen,closed=this.closed,g=this.g,prev=this.previous;
      const tx=target%n,ty=Math.floor(target/n)%n,tz=Math.floor(target/n2);
      const heuristicBase=this.fast?1.55:0.085;
      const heuristic=(x,y,z)=>heuristicBase*Math.hypot(x-tx,y-ty,z-tz);
      this.heap.clear();this.heap.push(start,heuristic(start%n,Math.floor(start/n)%n,Math.floor(start/n2)));
      seen[start]=stamp;g[start]=0;prev[start]=-1;
      let visited=0,found=false;
      const limit=this.fast?Math.min(this.count,60000):this.count;
      while(this.heap.size && visited<limit){
        const cur=this.heap.pop();if(closed[cur]===stamp)continue;closed[cur]=stamp;visited++;
        if(cur===target){found=true;break;}
        const x=cur%n,y=Math.floor(cur/n)%n,z=Math.floor(cur/n2);
        for(let m=0;m<this.moves.length;m++){
          const step=this.moves[m],xx=x+step.dx,yy=y+step.dy,zz=z+step.dz;
          if(xx<0||yy<0||zz<0||xx>=n||yy>=n||zz>=n)continue;
          const ni=xx+n*(yy+n*zz);
          if(solid[ni]||closed[ni]===stamp)continue;
          // Boundary-crossing validity matters especially for knight and diagonal moves.
          if((step.knight||step.type===1)&&!this.segmentClear(x,y,z,step.dx,step.dy,step.dz))continue;
          // Simpson quadrature along the actual 3D segment; all move types
          // pay for the material between the nodes, not just their endpoints.
          const midpointResistance=(base[cur]+4*this.sampleResistance(x+step.dx*.5,y+step.dy*.5,z+step.dz*.5)+base[ni])/6;
          const up=Math.max(0,step.dz)/step.length, vertical=Math.abs(step.dz)/step.length;
          const gradeFactor=1+this.climb*(.35*vertical+.65*up);
          const reinforcement=0.20+0.80*Math.exp(-this.learning*(traffic[cur]+traffic[ni])*.32);
          const edgeCost=step.length*midpointResistance*gradeFactor*reinforcement;
          const tentative=g[cur]+edgeCost;
          if(seen[ni]!==stamp||tentative<g[ni]){
            seen[ni]=stamp;g[ni]=tentative;prev[ni]=cur;
            this.heap.push(ni,tentative+heuristic(xx,yy,zz));
          }
        }
      }
      this.lastVisited=visited;
      if(!found){this.lastPath=null;return null;}
      let cur=target;const path=[];
      while(cur>=0&&path.length<=this.count){path.push(cur);cur=prev[cur];}
      path.reverse();this.lastPath=path;this.lastCost=g[target];
      this.tripCount++;
      // Trace memory deposits; each segment influences a small 3D neighborhood.
      for(let p=0;p<path.length;p++){
        const j=path[p];this.traffic[j]=Math.min(22,this.traffic[j]+.30);
        const [x,y,z]=this.xyz(j);
        const offsets=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
        for(let k=0;k<6;k++){
          const q=offsets[k],xx=x+q[0],yy=y+q[1],zz=z+q[2];
          if(xx<0||yy<0||zz<0||xx>=n||yy>=n||zz>=n)continue;
          const ni=this.index(xx,yy,zz);if(!solid[ni])this.traffic[ni]=Math.min(22,this.traffic[ni]+.045);
        }
      }
      return {path,cost:this.lastCost,visited,length:path.length,start,target};
    }
    step(){for(let attempt=0;attempt<3;attempt++){const [a,b]=this.trip(),route=this.findPath(a,b);if(route)return route;}return null;}
    diffuseCPU(keep=.97,spread=.09) {
      const n=this.n,n2=n*n,a=this.traffic,b=this.scratch,solid=this.solid;
      let i=0;
      for(let z=0;z<n;z++)for(let y=0;y<n;y++)for(let x=0;x<n;x++,i++){
        if(solid[i]){b[i]=0;continue;}
        const center=a[i];let sum=0,k=0;
        if(x>0&&!solid[i-1]){sum+=a[i-1];k++} if(x<n-1&&!solid[i+1]){sum+=a[i+1];k++}
        if(y>0&&!solid[i-n]){sum+=a[i-n];k++} if(y<n-1&&!solid[i+n]){sum+=a[i+n];k++}
        if(z>0&&!solid[i-n2]){sum+=a[i-n2];k++} if(z<n-1&&!solid[i+n2]){sum+=a[i+n2];k++}
        b[i]=Math.max(0,center*keep+spread*(sum-k*center));
      }
      this.traffic=b;this.scratch=a;
    }
    coverage(){
      let active=0,free=0;
      for(let i=0;i<this.count;i++){if(this.solid[i])continue;free++;if(this.traffic[i]>.14)active++;}
      return free?active/free:0;
    }
  }
  window.VolumeSimulation=VolumeSimulation;
  window.build3DMoves=buildMoves;
})();
