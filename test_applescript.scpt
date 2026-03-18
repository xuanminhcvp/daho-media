tell application "DaVinci Resolve"
    activate
end tell

tell application "System Events"
    tell process "DaVinci Resolve"
        -- Tấn công bằng Command P để mở Console? Hoặc Shift 9?
        keystroke "9" using {shift down}
        delay 0.5
        -- Đánh lệnh trực tiếp
        keystroke "print('AppleScript Working')"
        keystroke return
    end tell
end tell
