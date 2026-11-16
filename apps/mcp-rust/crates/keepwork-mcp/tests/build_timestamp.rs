#[path = "../src/build_timestamp.rs"]
mod build_timestamp;

#[test]
fn timestamp_is_compilation_time_or_explicit_reproducible_input() {
    use build_timestamp::select_timestamp;
    assert_eq!(
        select_timestamp(None, 1_800_000_000).unwrap(),
        (1_800_000_000, "compile-clock")
    );
    assert_eq!(
        select_timestamp(Some("1700000000"), 1_800_000_000).unwrap(),
        (1_700_000_000, "source-date-epoch")
    );
    assert_eq!(
        select_timestamp(Some("1700000000"), 1_900_000_000)
            .unwrap()
            .0,
        1_700_000_000
    );
    assert_eq!(select_timestamp(Some("0"), 1_800_000_000).unwrap().0, 0);
    for value in [
        "",
        "-1",
        "+1",
        "1.5",
        " 1700000000",
        "1700000000\n",
        "NaN",
        "1800000301",
        "253402300800",
        "18446744073709551615",
    ] {
        assert!(
            select_timestamp(Some(value), 1_800_000_000).is_err(),
            "{value}"
        );
    }
}
