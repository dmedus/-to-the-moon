' Inicia el servidor de To the Moon sin mostrar ninguna ventana.
' Una copia de este archivo en la carpeta "Inicio" de Windows lo arranca al prender la PC.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = "C:\Users\Dmedus\Desktop\Webs\Acciones\app"
sh.CurrentDirectory = appDir
sh.Run """" & appDir & "\servidor.cmd""", 0, False
