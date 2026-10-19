' Vigilante de To the Moon: una tarea programada de Windows lo corre cada 5 minutos, sin ventanas.
' Si el proceso que reinicia el servidor (servidor.cmd) no está corriendo, o el servidor no responde,
' lo vuelve a arrancar y lo anota en data\vigilante.log (así se sabe cuándo pasó).
' Si lo detuviste con detener.bat (existe data\detenido), no hace nada.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
flag = appDir & "\data\detenido"

Function Responde()
  Responde = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 3000, 3000, 5000, 5000
  http.open "GET", "http://127.0.0.1:3000/login.html", False
  http.send
  If Err.Number = 0 Then Responde = (http.status = 200)
  On Error GoTo 0
End Function

' El proceso que reinicia el servidor: cmd corriendo este servidor.cmd
Function LoopVivo()
  LoopVivo = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='cmd.exe' AND CommandLine LIKE '%\\Acciones\\app\\servidor.cmd%'").Count > 0
End Function

' PID que escucha en el puerto 3000 (0 si ninguno). Solo se corta ese: puede haber otros node de otros proyectos.
Function PidPuerto()
  PidPuerto = 0
  tmp = fso.GetSpecialFolder(2) & "\vigilante-netstat.txt"
  sh.Run "cmd /c netstat -ano -p tcp > """ & tmp & """", 0, True
  Set re = New RegExp
  re.Pattern = "TCP\s+\S+:3000\s+0\.0\.0\.0:0\s+\S+\s+(\d+)"
  Set f = fso.OpenTextFile(tmp, 1)
  Do Until f.AtEndOfStream
    Set m = re.Execute(f.ReadLine)
    If m.Count > 0 Then PidPuerto = CLng(m(0).SubMatches(0))
  Loop
  f.Close
  fso.DeleteFile tmp
End Function

Sub Cortar(pid)
  If pid = 0 Then Exit Sub
  For Each p In wmi.ExecQuery("SELECT * FROM Win32_Process WHERE ProcessId=" & pid) : p.Terminate : Next
End Sub

Sub Anotar(texto)
  Set f = fso.OpenTextFile(appDir & "\data\vigilante.log", 8, True)
  f.WriteLine "[" & Now & "] " & texto
  f.Close
End Sub

Sub Arrancar()
  sh.CurrentDirectory = appDir
  sh.Run """" & appDir & "\servidor.cmd""", 0, False
End Sub

If fso.FileExists(flag) Then
  ' Detenido a propósito. Si alguien lo volvió a arrancar, se vuelve a vigilar.
  If Not Responde() Then WScript.Quit
  fso.DeleteFile flag
End If

If LoopVivo() Then
  If Responde() Then WScript.Quit
  ' Puede estar en los 5 segundos entre un reinicio y el siguiente: se espera y se vuelve a probar
  WScript.Sleep 20000
  If Responde() Then WScript.Quit
  ' servidor.cmd vivo pero el servidor no responde (colgado): se corta para que servidor.cmd lo relance
  pid = PidPuerto()
  Anotar "El servidor no responde (servidor.cmd sigue corriendo): se reinicia el proceso " & pid
  Cortar pid
Else
  pid = PidPuerto()
  If pid > 0 Then
    ' El servidor anda pero sin nada que lo relance si se cae: se corta para arrancarlo con servidor.cmd
    Anotar "servidor.cmd no estaba corriendo (el servidor seguía andando, proceso " & pid & "): se arranca de nuevo"
    Cortar pid
    WScript.Sleep 2000
  Else
    Anotar "Ni servidor.cmd ni el servidor estaban corriendo: se arranca"
  End If
  Arrancar
End If
