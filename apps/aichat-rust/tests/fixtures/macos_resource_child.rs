fn main() {
    if std::env::args().nth(1).as_deref() == Some("hold") {
        std::thread::sleep(std::time::Duration::from_secs(20));
    } else {
        println!("fresh-executable-works");
    }
}
