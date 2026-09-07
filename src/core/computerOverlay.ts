export const computerOverlay = String.raw`
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class ControlOverlay : Form {
    public static System.Threading.Tasks.Task<string> ReadRequest() {
        return System.Threading.Tasks.Task.Run<string>(() => Console.In.ReadLine());
    }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr handle, uint affinity);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr handle, out uint affinity);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    public static bool Granted = false;
    public static DateTime LastAction;
    public static ControlOverlay Border;
    public static ControlOverlay Panel;
    public static ControlOverlay Tip;
    bool passthrough;
    public ControlOverlay(bool border, bool tip = false) {
        passthrough = border || tip;
        StartPosition = FormStartPosition.Manual;
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        var screen = Screen.PrimaryScreen.Bounds;
        if (border) {
            Bounds = screen;
            BackColor = Color.Cyan;
            var outline = new Region(ClientRectangle);
            outline.Exclude(new Rectangle(5, 5, Width - 10, Height - 10));
            Region = outline;
            Opacity = 0.65;
        } else {
            Size = new Size(Math.Min(560, screen.Width - 20), tip ? 30 : 38);
            Location = new Point(screen.Left + (screen.Width - Width) / 2, screen.Bottom - (tip ? 88 : 50));
            BackColor = Color.FromArgb(24, 27, 29);
            if (tip) {
                Opacity = 0.95;
            var label = new Label { Text = "AIChat agent is controlling your computer", ForeColor = Color.White, TextAlign = ContentAlignment.MiddleCenter, Dock = DockStyle.Top, Height = 30 };
                Controls.Add(label);
            } else {
            var button = new Button { Text = "Take Back Control", Dock = DockStyle.Bottom, Height = 38, BackColor = Color.White, TabStop = false };
            button.Click += delegate { Revoke(); };
            Controls.Add(button);
            }
        }
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override void OnHandleCreated(EventArgs args) {
        base.OnHandleCreated(args);
        ProtectCapture();
    }
    protected override CreateParams CreateParams {
        get { var parameters = base.CreateParams; parameters.ExStyle |= 0x08000000 | 0x80; if (passthrough) parameters.ExStyle |= 0x20 | 0x80000; return parameters; }
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; }
        base.WndProc(ref message);
    }
    void ProtectCapture() {
        uint affinity;
        if (!SetWindowDisplayAffinity(Handle, 0x11) || !GetWindowDisplayAffinity(Handle, out affinity) || affinity != 0x11)
            throw new InvalidOperationException("Capture exclusion unavailable");
    }
    public static void Grant() {
        Revoke();
        try {
            Border = new ControlOverlay(true); Panel = new ControlOverlay(false); Tip = new ControlOverlay(false, true);
            Border.ProtectCapture(); Panel.ProtectCapture(); Tip.ProtectCapture();
            Border.Show(); Panel.Show(); Tip.Show();
            Granted = true; LastAction = DateTime.UtcNow;
        } catch { Revoke(); throw; }
    }
    public static void Revoke() {
        Granted = false;
        if (Border != null) { Border.Dispose(); Border = null; }
        if (Panel != null) { Panel.Dispose(); Panel = null; }
        if (Tip != null) { Tip.Dispose(); Tip = null; }
    }
    public static void Check() {
        Application.DoEvents();
        if (Granted && (DateTime.UtcNow - LastAction).TotalMinutes >= 2) Revoke();
        if (!Granted) throw new InvalidOperationException("Control revoked");
    }
    public static void PrepareCapture() {
        Check();
        Border.ProtectCapture();
        Panel.ProtectCapture();
        Tip.ProtectCapture();
        if (DwmFlush() != 0) throw new InvalidOperationException("Capture exclusion synchronization failed");
    }
    public static bool IntersectsPanel(int x, int y) { return Panel != null && Panel.Bounds.Contains(x, y); }
}
`;