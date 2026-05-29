Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 245, 241, 233))

$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $rect,
  [System.Drawing.Color]::FromArgb(255, 22, 78, 99),
  [System.Drawing.Color]::FromArgb(255, 13, 148, 136),
  45.0
)
$g.FillEllipse($bgBrush, 12, 12, 232, 232)

$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 250, 253, 250), 10)
$g.DrawEllipse($ringPen, 28, 28, 200, 200)

$nodeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 250, 242))
$edgePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 255, 250, 242), 8)

$points = @(
  [System.Drawing.PointF]::new(78, 78),
  [System.Drawing.PointF]::new(178, 68),
  [System.Drawing.PointF]::new(192, 172),
  [System.Drawing.PointF]::new(88, 188),
  [System.Drawing.PointF]::new(128, 128)
)

$pairs = @(
  @(0, 4), @(1, 4), @(2, 4), @(3, 4),
  @(0, 1), @(1, 2), @(2, 3), @(3, 0)
)

foreach ($pair in $pairs) {
  $a = $points[$pair[0]]
  $b = $points[$pair[1]]
  $g.DrawLine($edgePen, $a, $b)
}

foreach ($pt in $points) {
  $g.FillEllipse($nodeBrush, $pt.X - 13, $pt.Y - 13, 26, 26)
}

$font = New-Object System.Drawing.Font('Segoe UI', 40, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$g.DrawString(
  'G',
  $font,
  (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 10, 37, 44))),
  (New-Object System.Drawing.RectangleF(72, 82, 112, 112)),
  $sf
)

$mediaDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'media'
if (-not (Test-Path $mediaDir)) {
  New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
}

$pngPath = Join-Path $mediaDir 'graphflow.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()

$icoPath = Join-Path $mediaDir 'graphflow.ico'
$fs = [System.IO.File]::Open($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$pngBytes.Length)
$bw.Write([UInt32]22)
$bw.Write($pngBytes)
$bw.Flush()
$bw.Close()
$fs.Close()

$g.Dispose()
$bmp.Dispose()
$bgBrush.Dispose()
$ringPen.Dispose()
$nodeBrush.Dispose()
$edgePen.Dispose()
$font.Dispose()
$ms.Dispose()

Write-Output "Generated $pngPath and $icoPath"
