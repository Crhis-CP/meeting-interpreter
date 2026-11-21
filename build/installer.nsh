; Windows uninstaller: asks whether to remove the downloaded models and settings too (the meeting
; records in Documents\MeetingInterpreter always stay). Not asked when the uninstall is part of an
; update, and "no" when run silently (the app's own 彻底卸载 deletes its data itself).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "同时删除下载的模型和设置吗？$\r$\n$\r$\n会议记录不会删除（在“文档\MeetingInterpreter”里）。" /SD IDNO IDNO mi_keep_data
      RMDir /r "$APPDATA\MeetingInterpreter"
      RMDir /r "$LOCALAPPDATA\MeetingInterpreter"
    mi_keep_data:
  ${endIf}
!macroend
