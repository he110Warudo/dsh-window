#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if dsh_window_lib::run_guard_if_requested() {
        return;
    }
    dsh_window_lib::run();
}
