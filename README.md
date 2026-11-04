# Claude Hub

Dashboard chạy trên máy bạn để quản lý nhiều phiên **Claude Code** cùng lúc, sắp theo dự án, nhánh git và worktree. Mỗi phiên là một terminal thật nhúng trong trình duyệt; hub cho biết phiên nào đang chạy, phiên nào đang chờ bạn trả lời, phiên nào đã xong, và báo bằng âm thanh hoặc thông báo của hệ điều hành.

## Tính năng

- **Nhiều phiên Claude song song**, nhóm theo dự án → nhánh/worktree. Trạng thái từng phiên (sẵn sàng, đang chạy, chờ bạn, xong, đã thoát) cập nhật trực tiếp qua hook của Claude Code.
- **Workspace**: thêm một folder cha chứa nhiều repo thì folder đó thành workspace, mở được một phiên Claude ở folder cha để làm việc trên tất cả các repo con cùng lúc.
- **Trang tổng quan**: phiên cần bạn xử lý luôn nằm đầu, kèm câu hỏi Claude đang chờ.
- **Lịch sử phiên**: liệt kê các phiên Claude Code đã lưu của từng thư mục (cả phiên mở ngoài hub) và **mở lại** bằng `claude --resume`.
- **MCP theo từng phiên**: xem các MCP server phiên đang dùng, kiểm tra kết nối, bật/tắt từng MCP. Đổi MCP sẽ khởi động lại phiên và giữ nguyên cuộc trò chuyện.
- **Skill/plugin theo từng phiên**: xem các plugin và skill phiên đang nạp, số token mô tả luôn nằm trong ngữ cảnh; tắt cả plugin, tắt skill riêng (`~/.claude/skills`, `.claude/skills`) hoặc chặn lẻ từng skill trong plugin. Đổi xong phiên khởi động lại và giữ nguyên cuộc trò chuyện.
- **Cuộn xem lại toàn bộ phiên**: hub mở Claude ở giao diện cổ điển (chỉ cho phiên mở từ hub), bộ nhớ cuộn tới 1 triệu dòng; RAM chỉ tăng theo số dòng thật sự in ra (khoảng 1,5 KB/dòng). Đổi trong Cài đặt → Phiên Claude.
- **Phím sao chép/dán** như Windows Terminal: bôi đen rồi Ctrl+C để sao chép (không bôi đen thì Ctrl+C vẫn là ngắt), Ctrl+Shift+C luôn sao chép, Ctrl+V / Ctrl+Shift+V / Shift+Insert để dán.
- **Terminal popup**: mở PowerShell, cmd hoặc Git Bash ngay tại thư mục của nhánh/phiên; nhiều tab, kéo thả, đổi kích thước, thu nhỏ.
- **Git**: tạo worktree/nhánh mới, xem file đã sửa và diff từng file, mở lazygit hoặc thư mục.
- **Text editor nhẹ** (CodeMirror): cây thư mục của dự án/workspace, nhiều tab, tô màu cú pháp (C#, JS/TS/JSX, JSON, HTML/XML, CSS/SCSS, SQL, Markdown, YAML, Python, PowerShell, shell…), tìm/thay thế, Ctrl+S để lưu. Giữ nguyên BOM và kiểu xuống dòng CRLF/LF; cảnh báo trước khi ghi đè file đã bị sửa bên ngoài (ví dụ Claude vừa sửa). Không có IntelliSense/debug — dùng VS Code cho việc đó.
- **Lịch sử git dạng cây**: cây commit có màu theo nhánh (merge, tách nhánh), nhãn nhánh/tag/remote, lọc theo nội dung hoặc tác giả, bấm vào commit để xem file đổi và diff. Chỉ xem, không thao tác lên repo.
- **Đặt tên** cho dự án, thư mục worktree và phiên; tự phân biệt hai thư mục trùng tên (ví dụ hai bản clone của cùng một repo).
- **Cài đặt giao diện**: bộ màu có sẵn, tự chọn màu, độ vát góc, cỡ chữ, font terminal, CSS tùy chỉnh; xuất/nhập cấu hình.

## Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| [Node.js](https://nodejs.org) **18 trở lên** | Kiểm tra bằng `node -v` |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) | Đã đăng nhập. Hub tìm `~/.local/bin/claude(.exe)` trước, sau đó tới `claude` trong `PATH` |
| Git | Để đọc nhánh, worktree và file đã sửa |
| [lazygit](https://github.com/jesseduffield/lazygit) | Không bắt buộc, chỉ dùng cho nút "lazygit" |

Hub dùng tốt nhất trên **Windows**. Phiên Claude và terminal popup chạy được trên macOS/Linux; riêng các nút "Thư mục" (mở Explorer) và "lazygit" hiện chỉ viết cho Windows.

Không cần cài trình biên dịch C++: thư viện terminal `@lydell/node-pty` có sẵn bản dựng cho Windows, macOS và Linux.

## Cài đặt

```bash
git clone https://github.com/hoanglanse04/claude-hub.git
cd claude-hub
npm ci
```

Chạy thử:

```bash
npm start
```

Muốn có lệnh `claude-hub` dùng ở mọi nơi:

```bash
npm install -g .
claude-hub
```

Hub mở dashboard tại <http://127.0.0.1:4317/>. Trên Windows có Microsoft Edge, dashboard mở thành cửa sổ riêng (chế độ app); máy khác mở bằng trình duyệt mặc định.

> **Giữ cửa sổ dòng lệnh của hub mở.** Đóng nó (hoặc Ctrl+C) sẽ dừng mọi phiên Claude và terminal đang chạy trong hub. Chạy `claude-hub` lần nữa khi hub đã chạy chỉ mở lại cửa sổ dashboard.

### Tùy chọn dòng lệnh

```
claude-hub [--port 4317] [--no-open]
```

| Tùy chọn | Ý nghĩa |
|---|---|
| `--port <số>` | Đổi cổng (mặc định `4317`) |
| `--no-open` | Không tự mở cửa sổ dashboard |
| `--help` | Xem hướng dẫn ngắn |

## Bắt đầu sử dụng

1. Bấm **Thêm dự án** và nhập đường dẫn một repo git, hoặc một thư mục chứa nhiều repo (hub quét sâu 2 cấp). Với thư mục chứa nhiều repo, hub thêm từng repo và tạo thêm một **workspace** cho chính thư mục đó: bấm **Toàn bộ workspace** để mở phiên Claude ở folder cha.
2. Ở sidebar, chọn một nhánh rồi bấm **▶** (hoặc **Phiên Claude mới** trong trang của nhánh).
3. Gõ yêu cầu trong terminal như dùng Claude Code bình thường. Khi Claude cần bạn hoặc làm xong, hub đổi trạng thái, phát âm thanh và gửi thông báo (bấm **Bật thông báo** một lần để cho phép).
4. Trang của nhánh có **Lịch sử phiên** để mở lại phiên cũ, nút **Terminal**, **lazygit** và danh sách **file đã sửa** (bấm vào để xem diff).
5. Trên thanh của một phiên:
   - **MCP**: xem và bật/tắt MCP server.
   - **Skill**: bật/tắt plugin và skill.
   - **Terminal**: mở shell tại thư mục của phiên.
   - **File đã sửa**, **Dừng**, **Đóng phiên**.
6. Đặt tên dự án, thư mục, workspace và phiên bằng nút bút chì trên từng dòng ở sidebar.
7. **Hướng dẫn sử dụng** (góc dưới bên trái sidebar) mở bản hướng dẫn đầy đủ ngay trong hub.
8. **Cài đặt** (góc phải trên cùng) để đổi giao diện, shell mặc định của terminal popup và âm thanh báo.

## Dữ liệu được lưu ở đâu

| Dữ liệu | Vị trí |
|---|---|
| Danh sách dự án, workspace, tên tùy đặt | `~/.claude-hub/config.json` |
| Hook báo trạng thái (tự tạo mỗi lần chạy) | `~/.claude-hub/hook-settings.json` |
| Cấu hình MCP riêng của từng phiên | `~/.claude-hub/mcp/<id>.json` (xóa khi đóng phiên) |
| Chọn plugin/skill riêng của từng phiên | `~/.claude-hub/settings/<id>.json` (hook + `enabledPlugins`, `skillOverrides`, `permissions.deny`; xóa khi đóng phiên) |
| Cài đặt giao diện | `localStorage` của trình duyệt, theo từng cổng |
| Lịch sử hội thoại | Do Claude Code tự lưu trong `~/.claude/projects/`; hub chỉ đọc |

Danh sách phiên đang mở và tên phiên chỉ nằm trong bộ nhớ của hub, mất khi tắt hub. Các cuộc trò chuyện thì vẫn còn trong lịch sử và mở lại được.

## Bảo mật

- Hub chỉ lắng nghe trên `127.0.0.1`, mỗi lần chạy sinh một token ngẫu nhiên; API và WebSocket từ chối request thiếu token hoặc đến từ origin khác.
- Hub chỉ gắn hook vào những phiên do chính nó mở (qua `--settings`), không đụng vào cấu hình Claude Code chung.
- Terminal popup chỉ chạy các shell có trong danh sách cho phép (PowerShell, pwsh, cmd, Git Bash; bash trên macOS/Linux).
- Text editor chỉ đọc/ghi được file nằm trong các dự án, worktree và workspace đã thêm vào hub (đường dẫn được giải symlink rồi mới kiểm tra). File lớn hơn 2 MB hoặc file nhị phân không mở được.
- File `~/.claude-hub/mcp/<id>.json` chép nguyên cấu hình MCP từ `~/.claude.json`, **kể cả token/mật khẩu** nếu có, giống file gốc. Trình duyệt không nhận được các giá trị này.
- Shell và phiên Claude chạy với quyền của tài khoản đang dùng máy.

## Biến môi trường (nâng cao)

| Biến | Ý nghĩa |
|---|---|
| `CLAUDE_HUB_PORT_LISTEN` | Cổng mặc định thay cho `4317` |
| `CLAUDE_HUB_HOME` | Thư mục dữ liệu thay cho `~/.claude-hub` |
| `CLAUDE_HUB_CLAUDE` | Đường dẫn tới lệnh `claude` |
| `CLAUDE_HUB_CLAUDE_JSON` | File cấu hình Claude Code thay cho `~/.claude.json` (nguồn đọc MCP) |
| `CLAUDE_HUB_HISTORY_ROOT` | Thư mục lịch sử thay cho `~/.claude/projects` |

## Phát triển

```bash
npm test        # chạy toàn bộ test (node --test)
```

Cấu trúc:

```
bin/claude-hub.js   khởi động server, mở cửa sổ dashboard
src/server.js       HTTP API + WebSocket, quét dự án định kỳ
src/sessions.js     phiên Claude Code (node-pty), trạng thái, khởi động lại
src/shells.js       terminal popup
src/history.js      đọc lịch sử phiên trong ~/.claude/projects
src/mcp.js          đọc cấu hình MCP, cấu hình riêng cho từng phiên, kiểm tra kết nối
src/skills.js       đọc plugin/skill, settings bật/tắt skill cho từng phiên
src/git.js          worktree, file đã sửa, diff
src/config.js       danh sách dự án, tên tùy đặt
src/status.js       chuyển trạng thái từ hook event
hooks/report.js     hook Claude Code gửi sự kiện về hub
public/             giao diện (HTML/CSS/JS thuần, không cần build)
```

## Xử lý sự cố

- **Phiên không đổi trạng thái**: kiểm tra hub còn chạy; hook gửi về `127.0.0.1:<cổng>` và tự bỏ qua nếu hub tắt. Phiên mở ngoài hub không có hook nên không hiện trạng thái.
- **Không tìm thấy `claude`**: đặt `CLAUDE_HUB_CLAUDE` trỏ tới file chạy của Claude Code.
- **Cổng 4317 đã bị dùng**: chạy `claude-hub --port 4400`.
- **MCP báo "lỗi"** trong panel MCP: rê chuột vào để xem lý do; thường do cấu hình server trong `~/.claude.json` hoặc dịch vụ phía sau (ví dụ database) chưa chạy.

## Tác giả

**Hoàng Lân Dev** — <https://github.com/hoanglanse04>
