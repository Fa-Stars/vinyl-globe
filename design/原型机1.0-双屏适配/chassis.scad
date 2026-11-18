$fn=64;
W=170; D=190; H=52; t=3; tilt=30;
sw=134; sh=88; st=5; // assumed rectangular display envelope
viewW=128; viewH=82; roundBody=96; roundView=90; roundT=5;
deckZ=H+t; hub=[85,95]; faceW=160; faceH=112;
armPivot=[145,178]; armH=22;
wood="#865b42"; cream="#f2e1bd"; green="#345646"; gold="#c89f62"; black="#272926";
module box(w,d,h,r=3){linear_extrude(h)translate([r,r])offset(r=r)square([w-2*r,d-2*r]);}
module hole(d,h,z=-1){translate([0,0,z]) cylinder(d=d,h=h);}
module grid(xs,ys){for(x=xs,y=ys)translate([x,y,0])children();}
module slot(a,b,d,h){hull(){translate(a)cylinder(d=d,h=h);translate(b)cylinder(d=d,h=h);}}
module lidfix(){grid([7,W-7],[7,D-7])children();}
module carrierfix(){grid([22,148],[32,150])children();}
module horizY(d,y,z,x,h){translate([x,y,z])rotate([-90,0,0])cylinder(d=d,h=h);}
module sideHole(d,y,z){translate([-2,y,z])rotate([0,90,0])cylinder(d=d,h=W+4);}
module wallcut(rear=false){
 y=rear?D-4:-1;
 translate([22,y,7])cube([W-44,6,38]);
 for(x=[16,W-16],z=[8,H-8]) horizY(3.5,y,z,x,6);
}
module tub(right=false){
 difference(){
  union(){difference(){box(W,D,H,5);translate([3,3,3])box(W-6,D-6,H+1,3);}
   lidfix()cylinder(d=10,h=H);carrierfix()cylinder(d=9,h=9);}
  lidfix()hole(2.65,13,H-12);carrierfix()hole(2.65,8,3);
  wallcut();wallcut(true);
  translate([right?-1:W-4,68,14])cube([5,52,22]);
  for(y=[27,163])translate([right?-1:W-4,y,25])rotate([0,90,0])cylinder(d=3.5,h=5);
 }
}
module dockfix(){grid([-69,69],[-63,63])children();}
module cheekfeet(){for(x=[18,142],y=[17,76])translate([5+x,49+y])children();}
module lid(right=false){
 difference(){box(W,D,t,5);lidfix()hole(3.5,7);
 if(right){translate([39,60,-1])box(92,68,6,4);cheekfeet()hole(3.5,6);}
 else{translate(hub)cylinder(d=143,h=8,center=true);translate(hub)dockfix()hole(3.5,7);
 translate(armPivot)hole(3.5,6);}}
}
module dockplate(h=5){difference(){translate([-78,-73,0])box(156,146,h);dockfix()hole(3.5,h+2);}}
module readerfix(){grid([10,59],[-18,18])children();}
module vinylDock(){difference(){dockplate();hole(12.3,8);hole(20,2.6); // 3.4 mm panel at button
 translate([17,-15,-1])box(36,30,4,2);
 readerfix()hole(2.2,4.8); for(p=[[-37,-21],[-49,19]])translate(p)hole(2.2,6);}}
module vinyl(){difference(){cylinder(d=136,h=4.5);hole(20,7);
 translate([35,0])hole(25.6,2.2,2.8);
 for(x=[16,54])translate([x,0])hole(1.65,4.2,0.6);
 for(p=[[-37,-21],[-49,19]])translate(p)hole(5.6,3.3);
 for(r=[55,58,61,64])translate([0,0,4.1])rotate_extrude()translate([r,0])square([.65,1]);}}
module taglid(){difference(){hull(){for(x=[-18,18])translate([x,0])cylinder(d=10,h=1.6);cylinder(d=30,h=1.6);}
 for(x=[-19,19])translate([x,0])hole(2.3,4);}}
module reader(){difference(){box(60,45,2.4,3);grid([5.5,54.5],[4.5,40.5])hole(2.7,5);
 translate([-4.5,22.5])hole(25,6); // service access to spindle button and its nut
 for(x=[13,22,38,47])translate([0,0,-1])slot([x,9],[x,36],3,6);}}
module sled(){difference(){box(140,130,3,5);grid([7,133],[6,124])hole(3.5,6);
 grid([24,82],[32,81])hole(2.8,6); // 58 x 49 mm mounting rectangle
 for(x=[19:10:119],y=[17,50,83])translate([0,0,-1])slot([x,y],[x,y+24],3.4,6);}}
module face(which){
 difference(){box(162,46,3);grid([12,150],[5,41])hole(3.5,6);
 if(which=="play"){translate([38,23])hole(16.2,7);
 grid([89,121],[7,39])hole(3.4,7);
 for(k=[-2:2])translate([0,0,-1])slot([94,23+k*4],[116,23+k*4],2.5,6);}
 if(which=="vol"){translate([119,23])hole(7.4,7);
 for(i=[0:9])translate([30+i*5,13,-1])box(2.6,20,6,1);}
 if(which=="io"){translate([22,14,-1])box(31,18,6);translate([76,23])hole(12.3,6);translate([111,14,-1])box(23,17,6);}
 }}
module arm(){difference(){union(){linear_extrude(4)hull(){circle(d=12);translate([-12,-72])circle(d=5);}
 cylinder(d=13,h=armH);translate([-16,-79,0])box(8,14,6,1);}
 hole(2.65,10,armH-9);}}
