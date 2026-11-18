// World Vinyl 1.0 / two-display engineering study. Millimetres.
// Select an individual printable part or review scene below.
part="assembly"; // [assembly,nfc,exploded,left-detail,right-detail,stand,carrier,bezel,dock,record,spider,rocker,switch-seat,spacer]
use <chassis.scad>
use <map.scad>
$fn=80;
wood="#996447"; ivory="#ede2c9"; forest="#274e49"; ink="#242927"; brass="#d8ab67";
pcb="#344f67"; artbg="#143735"; paper="#f0e8c9";
holePitch=[156.90,114.96]; board=[164.90,124.27]; tilt=30;
frame=[184,140]; mainWindow=[158,90]; windowCenter=[1,-3]; // adjustable mask
panelFront=7; roundActive=70.13; roundDepth=8.25;
hingeY=58; hingeZ=16.5; switchY=40; stopTop=13.70; // adjust to measured tactile-switch travel
roundHoles=[[-27.49,-18.11],[-27.49,17.89],[13.18,-29.61],[13.18,29.39]];
// Back view in supplier PDF reflected across Y for this face-up, tail-left layout.
module at(p){for(a=p) translate([a.x,a.y,0])children();}
module four(x,y){for(i=[-x,x],j=[-y,y])translate([i,j,0])children();}
module rr(w,d,h,r=2){translate([-w/2,-d/2,0])box(w,d,h,r);}
module bore(d,z,h){translate([0,0,z])cylinder(d=d,h=h);}
module slab(z,h,w,d,r=2){translate([0,0,z])rr(w,d,h,r);}
module tiltPlane(){translate([0,0,58])rotate([tilt,0,0])children();}
module stfeet(){for(y=[-29,30])translate([0,y,0])children();}
module stand(){
 difference(){
  union(){
   rr(12,130,4,2);
   for(s=[-1,1])intersection(){
    hull(){translate([0,s*54,0])rr(12,24,3);
           translate([0,s*66*cos(tilt),58+s*66*sin(tilt)+5])rr(12,15,3);}
    tiltPlane()translate([-20,-90,-160])cube([40,180,160]);
   }}
  stfeet()bore(3.5,-1,8);
  tiltPlane()for(y=[-66,66])translate([0,y,0])bore(2.65,-14,17);
 }}
module mholes(){four(holePitch.x/2,holePitch.y/2)children();}
module trimHoles(){four(86,63)children();}
module carrier(){difference(){
 union(){
  difference(){rr(frame.x,frame.y,4,5);boreRect=[146,104];slab(-1,7,boreRect.x,boreRect.y);}
  mholes()cylinder(d=8,h=4);
  trimHoles()cylinder(d=8,h=20.5);}
 mholes()bore(3.3,-1,7);
 trimHoles()bore(2.65,9,14);
 four(62,66)bore(3.4,-1,7);
 }}
module spacer(){difference(){cylinder(d=6.4,h=7);bore(3.3,-1,9);}}
module bezel(){difference(){rr(frame.x,frame.y,3,5);
 translate([windowCenter.x,windowCenter.y,-1])rr(mainWindow.x,mainWindow.y,6,1);
 trimHoles()bore(3.4,-1,6);}}
module mockMain(){
 color(pcb)difference(){union(){rr(board.x,103,1.6);
 mholes()cylinder(d=8,h=1.6);
 for(y=[-1,1],x=[-1,1])translate([x*holePitch.x/2,y*54,0])rr(8,9,1.6,1);}
 mholes()bore(3.2,-1,4);}
 color(ink)translate([0,-1.6,0])slab(1.6,5.3,164.2,99,1);
 translate([1.6,-4,0]){
 color(artbg)slab(6.9,.12,154.2,86,.6);
 translate([-38,0,7.06])scale([1.18,1.18,1])translate([-65.5,-64,0])map_pixels();
 color(brass)translate([-39,17,7.2])cylinder(d=2,h=.12);
 color(paper)for(line=[["Across the Plain",5.1,12],["Riverfield",3.8,3],["France",3.2,-7]])
 translate([5,line[2],7.1])linear_extrude(.12)text(line[0],size=line[1]);
 color("#91a99b")translate([5,-23,7.05])cube([62,.75,.15]);
 color(brass)translate([5,-23,7.22])cube([23,.85,.15]);
 color(paper)for(a=[["1:24",5],["3:52",60]])translate([a[1],-29,7.1])linear_extrude(.12)text(a[0],size=2.6);}
}
module rightPack(e=0){
 for(x=[-62,62])color(wood)translate([x,0,0])stand();
 tiltPlane(){
 color(forest)translate([0,0,e*14])carrier();
 color(brass)translate([0,0,4+e*29])mholes()spacer();
 translate([0,0,11+e*45])mockMain();
 color(ivory)translate([0,0,20.5+e*66])bezel();
 }}
module spiderFix(){four(45,33)children();}
module skinFix(){four(52,13)children();}
module seatFix(){for(x=[-27,27])translate([x,switchY,0])children();}
module dock(){difference(){dockplate(4);
 bore(89,-1,7);spiderFix()bore(2.65,-1,7);skinFix()bore(3.4,-1,7);
 translate([0,switchY+2,-1])rr(20,17,7);seatFix()bore(3.4,-1,7);
 }}
module axle(d){translate([-14,hingeY,hingeZ])rotate([0,90,0])cylinder(d=d,h=28);}
module record(){difference(){
 union(){
  difference(){bore(136,4,5.5);bore(75,3,4.8);bore(71.2,3,9);
    translate([-39,0,3])rr(8,33,4.8,1);
    for(r=[47,50,53,56,59,62,65])translate([0,0,9.12])rotate_extrude()translate([r,0])square([.6,1]);}
  for(x=[-6,6])hull(){translate([x,hingeY,8.9])rr(3.6,9,1,.8);
   translate([x-1.8,hingeY,hingeZ])rotate([0,90,0])cylinder(d=7,h=3.6);}
  translate([0,47.6,9.2])rr(4.4,2.4,stopTop-9.2,.6);
 }
 axle(2.3);skinFix()bore(2.65,3,5);
 translate([0,switchY,3])rr(19.5,12,10,1); seatFix()bore(7.4,3,3.7);
 }}
module rocker(){difference(){
 union(){
  hull(){translate([0,0,14])cylinder(d=10,h=2.6);
         translate([0,hingeY,14])rr(6.8,4,2.6,1);}
  intersection(){translate([-3.6,hingeY,hingeZ])rotate([0,90,0])cylinder(d=6.6,h=7.2);slab(14,8,30,130);}

  translate([0,0,16.5])cylinder(d1=12,d2=10,h=2.7);
 }axle(2.3);}}
module seat(){
 difference(){union(){
  hull(){seatFix()bore(7,-2.8,2.8);translate([0,switchY,-2.8])rr(17,13,2.8);}
  // Carrier with an open lead well and two screw bosses for a custom 17.5 x 9 mm switch board.
  for(x=[-6.35,6.35])translate([x,switchY,-.1])cylinder(d=4.8,h=8.0);
 }
 seatFix()bore(3.4,-4,6); for(x=[-6.35,6.35])translate([x,switchY,0])bore(1.65,1.5,8);
 translate([0,switchY,-4])rr(5,6,6,.7);
 }}
module spider(){difference(){union(){
 for(i=[0:3])let(p=roundHoles[i],s=[p.x<0?-45:45,p.y<0?-33:33]){
   hull(){translate([p.x,p.y,-6])cylinder(d=6,h=3);translate([s.x,s.y,-6])cylinder(d=8,h=3);}
   translate([p.x,p.y,-3.2])cylinder(d=5.4,h=panelFront-4.25+3.2);}
 difference(){slab(-6,3,96,72,5);slab(-7,5,88,64,4);}
 spiderFix()bore(8,-5.9,5.9);
 }spiderFix()bore(3.4,-7,9);at(roundHoles)bore(2.3,-7,12);
 }}
module roundMock(){
 color(pcb)difference(){hull(){bore(61,panelFront-4.25,1.95);at(roundHoles)bore(5.4,panelFront-4.25,1.95);}at(roundHoles)bore(2.2,2,4);} color("#515a61")translate([0,-10,panelFront-roundDepth])rr(25,14,4);
 color(ink)bore(73,panelFront-2.3,2.3);
 color(ink)translate([-38,0,panelFront-2.3])rr(6.18,27,2.3);
 color("#244f5f")bore(roundActive,panelFront,.10);
 // Original cover study: sunset, reflected light and mountain silhouettes.
 translate([0,0,panelFront+.12])intersection(){cylinder(d=roundActive,h=1);
 union(){
 color("#e9af69")translate([-11,8,0])cylinder(d=15,h=.10);
 color("#7e9d90")linear_extrude(.12)polygon([[-37,-7],[-17,10],[-6,0],[4,9],[24,-4],[36,8],[36,-30],[-37,-30]]);
 color("#446957")translate([0,0,.14])linear_extrude(.12)polygon([[-37,-6],[-20,-2],[-6,-10],[15,3],[37,-8],[36,-35],[-37,-35]]);
 color("#d4bb83")for(i=[0:3])translate([-15+i,-14-2*i,.29])cube([12-2*i,.7,.1]);}}
}
module leftPack(e=0){
 color(ivory)dock();
 color(forest)translate([0,0,-e*15])spider();
 translate([0,0,e*18])roundMock();
 color(ink)translate([0,0,e*42])record();
 color(forest)translate([0,0,-e*31])seat();
 color(brass)translate([0,0,e*59])rocker();
 color("#77847a")translate([-9,hingeY,hingeZ+e*59])rotate([0,90,0])cylinder(d=2,h=18);
 color(forest)translate([0,switchY,7.9-e*23])rr(17.5,9,1.6,1);
 color("#999783")translate([0,switchY,9.5-e*23])rr(6,6,3.5,.4);
 color(ink)translate([0,switchY,13-e*23])cylinder(d=3.5,h=.8);
}
module body(){
 for(i=[0,1])translate([170*i,0,0]){
 color(wood)tub(i==1);color(pcb)translate([15,26,9])sled();
 color(ivory)translate([0,0,52])lid(i==1);
 color(forest)translate([4,0,3])rotate([90,0,0])face(i==0?"play":"vol");
 color(forest)translate([4,193,3])rotate([90,0,0])face("io");}
 color(brass)translate([145,178,77])mirror([0,0,1])arm();
}
module full(e=0,nfc=false){
 body();
 translate([85,95,55+e*35])if(!nfc)leftPack(e);else{
 color(ivory)vinylDock();color(forest)translate([4.5,-22.5,-2.4])reader();
 color(ink)translate([0,0,5])vinyl();color(brass)translate([35,0,9.5])taglid();
 color(brass)translate([0,0,5])cylinder(d=16,h=7);}
 translate([255,95,55])rightPack(e);
}
if(part=="assembly")full();else if(part=="nfc")full(0,true);else if(part=="exploded")full(1);
else if(part=="left-detail")leftPack(1);else if(part=="right-detail")rightPack(1);
else if(part=="stand")translate([0,0,6])rotate([0,90,0])stand();
else if(part=="carrier")carrier();else if(part=="bezel")bezel();else if(part=="dock")dock();
else if(part=="record")translate([0,0,-4])record();
else if(part=="rocker")translate([0,0,-14])rocker();
else if(part=="switch-seat")translate([0,0,2.8])seat();
else if(part=="spider")translate([0,0,6])spider();else if(part=="spacer")spacer();
