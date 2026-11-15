//! Small native boundary shared by the unchanged terminal HTTP/session layer.
use std::io::{Read, Write};
use std::path::Path;

#[derive(Clone, Copy)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}
pub trait PtyControl: Send {
    fn resize(&self, size: PtySize) -> Result<(), String>;
}
pub trait ChildControl: Send + Sync {
    fn kill(&mut self) -> Result<(), String>;
}
pub struct SpawnedTerminal {
    pub master: Box<dyn PtyControl>,
    pub child: Box<dyn ChildControl>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

#[cfg(all(windows, any(target_vendor = "win7", feature = "win7-compat")))]
pub fn spawn_shell(
    shell: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
) -> Result<SpawnedTerminal, String> {
    super::winpty::spawn(shell, args, cwd, size)
}

#[cfg(not(all(windows, any(target_vendor = "win7", feature = "win7-compat"))))]
pub fn spawn_shell(
    shell: &str,
    args: &[String],
    cwd: &Path,
    size: PtySize,
) -> Result<SpawnedTerminal, String> {
    use portable_pty::{native_pty_system, CommandBuilder, MasterPty};
    struct Master(Box<dyn MasterPty + Send>);
    impl PtyControl for Master {
        fn resize(&self, size: PtySize) -> Result<(), String> {
            self.0
                .resize(portable_pty::PtySize {
                    rows: size.rows,
                    cols: size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| error.to_string())
        }
    }
    struct Child(Box<dyn portable_pty::Child + Send + Sync>);
    impl ChildControl for Child {
        fn kill(&mut self) -> Result<(), String> {
            self.0.kill().map_err(|error| error.to_string())
        }
    }
    let pair = native_pty_system()
        .openpty(portable_pty::PtySize {
            rows: size.rows,
            cols: size.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new(shell);
    command.args(args);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let opened = (|| {
        Ok((
            pair.master
                .try_clone_reader()
                .map_err(|error| error.to_string())?,
            pair.master
                .take_writer()
                .map_err(|error| error.to_string())?,
        ))
    })();
    let (reader, writer) = match opened {
        Ok(value) => value,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    Ok(SpawnedTerminal {
        master: Box::new(Master(pair.master)),
        child: Box::new(Child(child)),
        reader,
        writer,
    })
}
