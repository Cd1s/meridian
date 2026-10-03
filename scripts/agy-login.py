#!/usr/bin/env python3
import pty, os, time, select, fcntl, termios, struct, sys, re, signal, pwd, ctypes

if len(sys.argv) < 2:
    print("Usage: agy-login.py <accN>")
    sys.exit(1)

acc = sys.argv[1]
if not re.fullmatch(r"acc[0-9]+", acc):
    print("Invalid account name")
    sys.exit(1)

accounts_dir = os.environ.get("MERIDIAN_AGY_ACCOUNTS_DIR", "/var/lib/meridian/instances")
home_dir = os.path.join(accounts_dir, acc)
env_file = os.path.join(home_dir, "env")
env_vars = {}
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env_vars[k.strip()] = v.strip().strip("\"'")

# Same isolation as accounts mode: private HOME, temp and XDG dirs, plus every non-MERIDIAN_ variable.
tmp_dir = os.path.join(home_dir, ".tmp")
os.makedirs(tmp_dir, mode=0o700, exist_ok=True)
agy_env = {
    "HOME": home_dir, "TMPDIR": tmp_dir,
    "XDG_CONFIG_HOME": os.path.join(home_dir, ".config"), "XDG_CACHE_HOME": os.path.join(home_dir, ".cache"),
    "XDG_DATA_HOME": os.path.join(home_dir, ".local", "share"), "XDG_STATE_HOME": os.path.join(home_dir, ".local", "state"),
}
agy_env.update({k: v for k, v in env_vars.items() if not k.startswith("MERIDIAN_")})

master, slave = pty.openpty()
winsize = struct.pack("HHHH", 35, 120, 0, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)

pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    # Run as the service user so the login never leaves root-owned files in the account dir.
    user = pwd.getpwnam("meridian")
    if os.getuid() != user.pw_uid:
        os.setgid(user.pw_gid)
        os.setuid(user.pw_uid)
    # Set after setuid, which clears it: if this script is SIGKILLed, the kernel still stops agy.
    try: ctypes.CDLL(None).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG
    except Exception: pass
    os.environ.update(agy_env)
    os.environ["TERM"] = "xterm-256color"
    os.execvp("/usr/local/bin/agy", ["agy"])
else:
    os.close(slave)
    fifo_path = f"/tmp/agy_{acc}.fifo"
    fifo_ino = None

    # The admin panel ends an abandoned login (timeout, new login, disable) with SIGTERM to this
    # script. agy runs in its own session, so it has to be stopped here or it lingers (~225 MB).
    def stop(signum, frame):
        raise SystemExit(128 + signum)
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(s, stop)

    try:
        time.sleep(2)
        os.write(master, b"\r")
        time.sleep(2)
        raw = b""
        while True:
            r, _, _ = select.select([master], [], [], 0.5)
            if not r: break
            raw += os.read(master, 4096)
    
        text = raw.decode("utf-8", errors="ignore")
        urls = re.findall(r"https://accounts\.google\.com/o/oauth2/auth[^\s\x1b\]]+", text)
        if urls:
            # The TUI redraw can glue a second copy of the URL onto the first one.
            url = "https://" + urls[0][len("https://"):].split("https://")[0]
            print("AUTH_URL=" + url, flush=True)
        else:
            print("RAW_OUTPUT=" + text, flush=True)

        if os.path.exists(fifo_path):
            os.remove(fifo_path)
        os.mkfifo(fifo_path)
        # Only the account's service user (or root running this script) may hand in a code.
        os.chmod(fifo_path, 0o600)
        fifo_ino = os.stat(fifo_path).st_ino
        print("READY_FOR_CODE", flush=True)
        token = os.path.join(home_dir, ".gemini/antigravity-cli/antigravity-oauth-token")
        # A re-login only succeeds if agy writes a new token; an old file must not count.
        before = os.stat(token).st_mtime_ns if os.path.exists(token) else None
        with open(fifo_path, "r") as fifo:
            code = fifo.read().strip()
        os.remove(fifo_path)
        fifo_ino = None
        os.write(master, (code + "\r").encode("utf-8"))
        time.sleep(4)
        out = b""
        while True:
            r, _, _ = select.select([master], [], [], 1.0)
            if not r: break
            out += os.read(master, 4096)
        print("LOGIN_RESULT=" + out.decode("utf-8", errors="ignore"), flush=True)
        time.sleep(6)
    finally:
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(s, signal.SIG_IGN)
        # The TUI keeps running after login too.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try: os.killpg(pid, sig)
            except ProcessLookupError: break
            time.sleep(2)
        try: os.waitpid(pid, 0)
        except ChildProcessError: pass
        # A newer login for the same account may already own the path; remove only our FIFO.
        try:
            if fifo_ino is not None and os.stat(fifo_path).st_ino == fifo_ino: os.remove(fifo_path)
        except FileNotFoundError: pass
    saved = os.path.exists(token) and os.stat(token).st_mtime_ns != before
    print("TOKEN_SAVED=" + ("yes" if saved else "no"), flush=True)
