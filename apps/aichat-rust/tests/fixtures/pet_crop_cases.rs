use pet::{WorkArea,PetHitRegion,PetHitMask};
fn area()->WorkArea{WorkArea{x:-1920,y:-200,width:1920,height:1080}}
fn fallback()->WorkArea{WorkArea{x:-1820,y:-100,width:112,height:112}}
fn region(id:&str,left:f64,top:f64,width:f64,height:f64,bits:Option<&str>)->PetHitRegion{
 PetHitRegion{id:id.into(),left,top,width,height,mask:bits.map(|bits|PetHitMask{width:4,height:4,bits:bits.into()})}
}
#[test] fn collapsed_alpha_body_crops_transparent_padding_on_negative_monitor(){
 let body=region("pet",100.,100.,112.,112.,Some("0660"));
 assert_eq!(pet_crop::crop(area(),fallback(),&[body]),WorkArea{x:-1792,y:-72,width:56,height:56});
}
#[test] fn alpha_holes_do_not_change_outer_window_bounds(){
 let solid=region("pet",100.,100.,112.,112.,Some("ffff"));
 let hollow=region("pet",100.,100.,112.,112.,Some("f99f"));
 assert_eq!(pet_crop::crop(area(),fallback(),&[solid]),pet_crop::crop(area(),fallback(),&[hollow]));
}
#[test] fn expanded_panel_and_reply_are_not_clipped_by_sprite_bounds(){
 let regions=[region("pet",100.,100.,112.,112.,Some("0660")),region("panel",250.,80.,300.,200.,None),region("bubble",80.,20.,160.,60.,None)];
 assert_eq!(pet_crop::crop(area(),fallback(),&regions),WorkArea{x:-1840,y:-180,width:470,height:260});
}
#[test] fn missing_or_unusable_regions_fall_back_to_small_body_never_monitor(){
 assert_eq!(pet_crop::crop(area(),fallback(),&[]),fallback());
 for bad in [region("pet",100.,100.,112.,112.,Some("0000")),region("pet",100.,100.,112.,112.,Some("zzzz")),region("pet",f64::NAN,0.,112.,112.,None),region("pet",0.,0.,f64::INFINITY,112.,None),region("panel",0.,0.,-1.,20.,None)]{
 assert_eq!(pet_crop::crop(area(),fallback(),&[bad]),fallback());
 }
}
#[test] fn offscreen_content_is_clipped_to_owning_monitor(){
 let body=region("pet",1900.,1060.,112.,112.,None);
 assert_eq!(pet_crop::crop(area(),fallback(),&[body]),WorkArea{x:-20,y:860,width:20,height:20});
}
#[test] fn fallback_crossing_negative_monitor_edge_is_intersected_not_shifted(){
 let outside=WorkArea{x:-1940,y:-220,width:112,height:112};
 assert_eq!(pet_crop::crop(area(),outside,&[]),WorkArea{x:-1920,y:-200,width:92,height:92});
}
