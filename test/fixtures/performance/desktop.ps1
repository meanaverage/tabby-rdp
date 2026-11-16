# Dedicated Windows test session only. F6 changes the latency patch; F7 pauses motion; F8 resumes; Escape exits.
# Run in the target's interactive session before test/suites/freerdp-benchmark.ts.
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
public class RdpBenchmarkDesktop : Form {
    readonly Timer timer = new Timer();
    int frame; bool pulse; bool moving = true;
    public RdpBenchmarkDesktop() {
        Text = "RDP comparison workload";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = Point.Empty; ClientSize = new Size(1280,800);
        TopMost = true; DoubleBuffered = true; KeyPreview = true;
        timer.Interval = 33;
        timer.Tick += (s,e) => { if(moving) { frame++; Invalidate(); } };
        timer.Start();
        KeyDown += (s,e) => {
            if(e.KeyCode == Keys.F6) { pulse = !pulse; Invalidate(); }
            if(e.KeyCode == Keys.F7) { moving = false; Invalidate(); }
            if(e.KeyCode == Keys.F8) { moving = true; Invalidate(); }
            if(e.KeyCode == Keys.Escape) Close();
        };
        FormClosed += (s,e) => timer.Dispose();
    }
    protected override void OnPaint(PaintEventArgs e) {
        var g=e.Graphics; g.Clear(Color.FromArgb(24,32,48));
        for(int i=0;i<18;i++) {
            int x=(frame*7+i*67)%1280;
            using(var b=new SolidBrush(Color.FromArgb(80+i*8,180-i*5,60+i*9)))
                g.FillRectangle(b,x,55+i*37,130,25);
            g.DrawString("Remote desktop text, shapes and repeated bitmap regions",SystemFonts.DefaultFont,Brushes.White,20,60+i*37);
        }
        // Magic marker and frame counter: read back by the client; tile callbacks are not display frames.
        g.FillRectangle(Brushes.Magenta,0,0,8,16);
        for(int i=0;i<24;i++) g.FillRectangle((frame & (1<<i))!=0 ? Brushes.White : Brushes.Black,8+i*8,0,8,16);
        g.FillRectangle(pulse ? Brushes.Red : Brushes.Blue,220,0,24,16);
    }
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
[Windows.Forms.Application]::Run((New-Object RdpBenchmarkDesktop))
