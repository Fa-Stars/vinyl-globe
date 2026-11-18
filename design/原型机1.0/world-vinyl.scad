// World Vinyl 1.0 | mm. Default view is the assembled visual prototype.
part="assembly";
$fn=72;
half_w=150; depth=180; body_h=40; wall=2.8; deck_t=3;
screen_w=131; screen_h=100; tilt=30; // removable dummy insert
record_d=128; key_d=12;
pivot=[138,145]; hub=[74,88];
wood="#81543b"; ivory="#eee1c2"; pine="#233f35"; ink="#202221"; brass="#c19c5b";
eps=0.02;
module slab(w,d,h,r=4){linear_extrude(h) translate([r,r]) offset(r=r) square([w-2*r,d-2*r]);}
module outer(){slab(2*half_w,depth,body_h,8);}
module sidecut(s){translate([s*half_w,-1,-1]) cube([half_w,depth+2,body_h+10]);}
module bosses(s){for(x=[7,half_w-7],y=[7,depth-7]) translate([s*half_w+x,y,0]) children();}
module tray(s){
 difference(){
  union(){
   difference(){
    intersection(){outer();sidecut(s);}
    translate([wall+s*half_w,wall,wall]) slab(half_w-2*wall,depth-2*wall,body_h,5);
   }
   bosses(s) cylinder(d=10,h=body_h);
   // Fixed stop under the left-deck flexure. The last 1.2 mm is air.
   if(s==0)translate(hub)cylinder(d=10,h=body_h-1.2);
  }
  bosses(s) translate([0,0,body_h-14]) cylinder(d=2.7,h=15);
  for(y=[35,depth-35]) translate([half_w-wall-1,y,16]) rotate([0,90,0]) cylinder(d=3.5,h=2*wall+2);
 }
}
// Three slits leave a 26 mm cantilever; underside printed flat.
module tongue_cuts(){
 for(x=[-4.5,3.5]) translate([x,-23,-1]) cube([1,28,6]);
 translate([-4.5,5,-1]) cube([9,1,6]);
 translate([-3.5,-23,1.6]) cube([7,29,3]); // top relief
}
module deck(s){
 difference(){
  intersection(){slab(half_w*2,depth,deck_t,8);sidecut(s);}
  bosses(s) translate([0,0,-1]) cylinder(d=3.5,h=6);
  if(s==0) translate(hub) tongue_cuts();
 }
}
module disc(){difference(){cylinder(d=record_d,h=3);translate([0,0,-1]) cylinder(d=key_d+1.4,h=6);
 for(r=[40:3:61]) translate([0,0,2.6]) rotate_extrude() translate([r,0]) square([0.65,1]);}}
module label(){difference(){cylinder(d=50,h=1.2);translate([0,0,-1]) cylinder(d=key_d+1.4,h=3);}}
module arrow2d(){polygon([[-2,-2],[-2,2],[0.8,0]]);}
module cap(){difference(){
 union(){cylinder(d=6,h=5.4);translate([0,0,5.39]) cylinder(d=key_d,h=2);}
 translate([0,0,6.75])linear_extrude(1)union(){arrow2d();translate([1.2,-2])square([0.9,4]);}
}}
module coupon(){difference(){slab(36,52,deck_t);translate([18,33,0]) tongue_cuts();}}
// Two triangular rails joined at base; print foot down.
module rail(len){ rotate([90,0,90]) linear_extrude(4) polygon([[0,0],[len*cos(tilt),0],[len*cos(tilt),6+len*sin(tilt)],[0,6]]);}
fw=screen_w+7; fh=screen_h+7;
module stand(){union(){rail(fh);translate([fw-4,0,0]) rail(fh);
 for(y=[1,fh*cos(tilt)-6]) translate([0,y,0]) cube([fw,5,3]);}}
module frame(){difference(){slab(fw,fh,4,3);
 translate([3.2,3.2,1.8]) slab(screen_w+0.6,screen_h+0.6,4,2);
 translate([8,8,-1]) slab(fw-16,fh-16,5,2);}}
module insert(){slab(screen_w,screen_h,2,2);}
module fascia(s){difference(){slab(half_w-6,28,2,4);
 for(row=[0:2],i=[0:5]) translate([(s==0?64:8)+i*12,6+row*6,-1]) slab(9,2.6,4,1);}}
module knob(){difference(){cylinder(d=23,h=8);translate([-.55,5,7.2])cube([1.1,5.4,1]);}}
module play(){difference(){cylinder(d=15,h=3);translate([0,0,2.4])linear_extrude(1)
 union(){translate([-1,0])arrow2d();for(x=[1,2.8])translate([x,-2])square([.9,4]);}}}
// Arm exported with its flat upper face on bed; pivot peg points up in print.
module arm(){union(){linear_extrude(3) hull(){circle(d=10);translate([-9,-69]) circle(d=5);}
 cylinder(d=10,h=10);translate([-12,-79,0]) cube([7,14,5]);}}
module rig(){translate([half_w+(half_w-fw)/2,38,body_h+deck_t]) children();}
module screenplane(){rig() translate([0,0,6]) rotate([tilt,0,0]) children();}
module assembly(){
 for(s=[0:1]){
  color(wood) tray(s);color(ivory) translate([0,0,body_h])deck(s);
  color(pine) translate([s*half_w+3,0,6])rotate([90,0,0])fascia(s);
 }
 translate([hub.x,hub.y,body_h+deck_t]){
  color(ink)disc();color(ivory)translate([0,0,3])label();
  color(brass)translate([0,0,1.6-deck_t])cap();
 }
 color(brass)translate([pivot.x,pivot.y,body_h+deck_t+10])mirror([0,0,1])arm();
 color(brass)translate([32,-2,20])rotate([90,0,0])play();
 color(brass)translate([268,-2,20])rotate([90,0,0])knob();
 color(ivory)rig()stand();color(ivory)screenplane()frame();
 color(pine)screenplane()translate([3.5,3.5,1.8])insert();
 screenplane()translate([3.5,3.5,3.82]) scale([screen_w/131,screen_h/100,1])screen_art();
}
include <screen-art.scad>
if(part=="assembly")assembly();
else if(part=="tray-L")tray(0);else if(part=="tray-R")translate([-half_w,0,0])tray(1);
else if(part=="deck-L")deck(0);else if(part=="deck-R")translate([-half_w,0,0])deck(1);
else if(part=="fascia-L")fascia(0);else if(part=="fascia-R")fascia(1);
else if(part=="disc")disc();else if(part=="label")label();else if(part=="center-key")mirror([0,0,1])translate([0,0,-7.39])cap();
else if(part=="key-coupon")coupon();else if(part=="arm")arm();else if(part=="play")play();
else if(part=="volume")knob();else if(part=="screen-stand")stand();
else if(part=="screen-frame")frame();else if(part=="screen-insert")insert();
