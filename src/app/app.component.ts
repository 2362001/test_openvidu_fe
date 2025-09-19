import { HttpClient } from '@angular/common/http';
import { Component, HostListener, OnDestroy, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    createLocalScreenTracks, // API LiveKit tạo track chia sẻ màn hình (video + optional audio)
    LocalTrack, // Kiểu track local (audio/video)
    LocalVideoTrack, // Kiểu track local video (để lấy mediaStreamTrack và listen 'ended')
    RemoteParticipant,
    RemoteTrack,
    RemoteTrackPublication,
    Room, // Đối tượng “phòng” của LiveKit
    RoomEvent, // Enum các sự kiện trong Room
    Track,
    VideoPresets, // Để truy cập Track.Source.ScreenShare
} from 'livekit-client';
import { lastValueFrom } from 'rxjs';
import { AudioComponent } from './audio/audio.component';
import { VideoComponent } from './video/video.component';

// --------- Kiểu dữ liệu lưu trong remoteTracksMap ---------
// Lưu publication (audio/video) + danh tính participant chủ sở hữu
type TrackInfo = {
    trackPublication: RemoteTrackPublication;
    participantIdentity: string;
};

// --------- Cấu hình endpoint backend và LiveKit ---------
// Để trống -> sẽ tự suy ra trong runtime ở this.configureUrls()
let APPLICATION_SERVER_URL = '';
let LIVEKIT_URL = '';

@Component({
    selector: 'app-root',
    standalone: true,
    imports: [ReactiveFormsModule, AudioComponent, FormsModule, VideoComponent],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss',
})
export class AppComponent implements OnDestroy {
    // --------- Form nhập tên phòng và tên người dùng ---------
    // Sử dụng Reactive Forms để có validate required
    roomForm = new FormGroup({
        roomName: new FormControl('Test Room', Validators.required),
        participantName: new FormControl('Participant' + Math.floor(Math.random() * 100), Validators.required),
    });

    // --------- State chính dùng Angular Signals ---------
    room = signal<Room | undefined>(undefined); // Room hiện tại
    remoteTracksMap = signal<Map<string, TrackInfo>>(new Map()); // Map<trackSid, TrackInfo> cho audio/screen-share
    participants = signal<string[]>([]); // Danh sách participant (tên or identity)

    constructor(private httpClient: HttpClient) {
        this.configureUrls(); // Suy ra URL theo môi trường
    }

    // private configureUrls() {
    //     // URL server ứng dụng (Spring/Node) dùng để cấp token LiveKit
    //     if (!APPLICATION_SERVER_URL) {
    //         if (window.location.hostname === 'localhost') {
    //             APPLICATION_SERVER_URL = 'http://localhost:6080/'; // dev
    //         } else {
    //             APPLICATION_SERVER_URL = 'https://' + window.location.hostname + ':6443/'; // ví dụ khi bạn dùng SSL trên 6443
    //         }
    //     }
    //     // URL LiveKit (WS/WSS)
    //     if (!LIVEKIT_URL) {
    //         if (window.location.hostname === 'localhost') {
    //             LIVEKIT_URL = 'ws://localhost:7880'; // cổng mặc định LiveKit dev (không TLS)
    //         } else {
    //             LIVEKIT_URL = 'wss://' + window.location.hostname + ':7881'; // cổng mặc định LiveKit TLS
    //             // nếu đã reverse proxy qua 443 thì có thể dùng: LIVEKIT_URL = 'wss://' + window.location.hostname;
    //         }
    //     }
    // }

    private configureUrls() {
        // ⛳️ Dùng LAN IP của máy bạn: 10.145.31.185
        // Backend Spring Boot (cấp token)
        APPLICATION_SERVER_URL = 'http://192.168.137.1:6080/';

        // LiveKit (dev, không TLS)
        LIVEKIT_URL = 'ws://192.168.137.1:7880';

        // Nếu sau này bạn bật TLS + reverse proxy:
        // APPLICATION_SERVER_URL = 'https://your-domain/'; // proxy -> Spring
        // LIVEKIT_URL = 'wss://your-domain';               // proxy -> LiveKit
    }

    // --------- State cho chat (DataChannel) ---------
    messages = signal<{ from: string; text: string }[]>([]);
    chatInput = '';

    // --------- Join room: đăng ký các event + kết nối + bật mic ----------
    async joinRoom() {
        const room = new Room();
        this.room.set(room);

        // Nhận tin nhắn data (chat) từ các participant khác
        room.on(RoomEvent.DataReceived, (payload, participant, _kind, _topic) => {
            const text = new TextDecoder().decode(payload);
            const from = participant?.name || participant?.identity || 'Unknown';
            this.messages.update((list) => [...list, { from, text }]);
            // (gợi ý) có thể auto-scroll hộp chat ở đây
        });

        // Khi subscribe track remote (SDK đã đàm phán xong và track sẵn sàng)
        room.on(
            RoomEvent.TrackSubscribed,
            (_track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
                // audio
                if (publication.kind === 'audio') {
                    this.remoteTracksMap.update((map) => {
                        map.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return map;
                    });
                }

                // ✅ video: nhận cả Camera & ScreenShare (+ fallback Unknown)
                if (
                    publication.kind === 'video' &&
                    (publication.source === Track.Source.Camera ||
                        publication.source === Track.Source.ScreenShare ||
                        publication.source === Track.Source.Unknown || // đôi lúc SDK để Unknown
                        publication.source === (undefined as any))
                ) {
                    this.remoteTracksMap.update((map) => {
                        map.set(publication.trackSid, {
                            trackPublication: publication,
                            participantIdentity: participant.identity,
                        });
                        return map;
                    });
                }
            }
        );

        // Khi một remote publication bị hủy/không còn subscribe
        room.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, publication: RemoteTrackPublication) => {
            this.remoteTracksMap.update((map) => {
                map.delete(publication.trackSid);
                return map;
            });
        });

        // Cập nhật danh sách người tham gia khi có người ra/vào/đổi tên
        room.on(RoomEvent.ParticipantConnected, (p) => {
            this.participants.update((list) => Array.from(new Set([...list, p.name || p.identity])));
        });
        room.on(RoomEvent.ParticipantDisconnected, (p) => {
            const id = p.name || p.identity;
            this.participants.update((list) => list.filter((x) => x !== id));
        });
        room.on(RoomEvent.ParticipantNameChanged, (name, p) => {
            const id = p.identity;
            this.participants.update((list) => {
                const next = list.slice();
                const idx = next.findIndex((x) => x === id || x === (p.name || id));
                if (idx !== -1) next[idx] = name || id;
                return next;
            });
        });

        try {
            const roomName = this.roomForm.value.roomName!;
            const participantName = this.roomForm.value.participantName! + '-' + Math.floor(Math.random() * 10000);

            // 1) Lấy JWT token từ backend để join room (role/grants đã set ở server)
            const token = await this.getToken(roomName, participantName);

            // 2) Kết nối LiveKit qua WS/WSS
            await room.connect(LIVEKIT_URL, token);

            // 3) Cập nhật danh sách người: self + những người đã ở trong phòng
            const existing = Array.from(room.remoteParticipants.values()).map((p) => p.name || p.identity);
            this.participants.set([participantName, ...existing]);

            // 4) Audio-only: tắt camera, bật mic (có thể đổi theo nhu cầu)
            await room.localParticipant.setCameraEnabled(false);
            await room.localParticipant.setMicrophoneEnabled(false);
        } catch (error: any) {
            console.log('Error connecting:', error?.error?.errorMessage || error?.message || error);
            await this.leaveRoom(); // dọn dẹp nếu lỗi
        }
    }

    //test thử

    // --------- Gửi chat qua DataChannel (reliable) ---------
    async sendMessage() {
        if (!this.chatInput.trim() || !this.room()) return;

        const msg = this.chatInput.trim();
        const data = new TextEncoder().encode(msg);

        // publish dữ liệu đến mọi người trong phòng (reliable giống TCP)
        await this.room()!.localParticipant.publishData(data, {
            reliable: true,
            // (gợi ý) có thể thêm topic: 'chat' để lọc theo chủ đề
        });

        // tự hiển thị tin nhắn của mình
        this.messages.update((list) => [...list, { from: 'Me', text: msg }]);
        this.chatInput = '';
    }

    // --------- Rời phòng: nhớ dừng share nếu đang bật, sau đó disconnect ----------
    async leaveRoom() {
        if (this.isScreenSharing) {
            await this.stopScreenShare();
        }
        await this.room()?.disconnect();
        this.room.set(undefined);
        this.remoteTracksMap.set(new Map());
        this.participants.set([]);
    }

    // --------- Đảm bảo rời phòng khi đóng tab/reload ----------
    @HostListener('window:beforeunload')
    async ngOnDestroy() {
        await this.leaveRoom();
    }

    // --------- Gọi backend lấy token LiveKit ----------
    private async getToken(roomName: string, participantName: string): Promise<string> {
        const res = await lastValueFrom(
            this.httpClient.post<{ token: string }>(APPLICATION_SERVER_URL + 'token', { roomName, participantName })
        );
        return res.token;
    }

    // ===================== Chia sẻ màn hình =====================

    isScreenSharing = false; // cờ trạng thái share
    private screenShareTracks: LocalTrack[] = []; // lưu chính các LocalTrack tạo bởi createLocalScreenTracks

    // Bật/tắt chia sẻ màn hình
    async toggleScreenShare() {
        if (!this.room()) return;
        try {
            if (!this.isScreenSharing) {
                const ok = await this.startScreenShare(true);
                if (!ok) console.warn('Screen share could not start');
            } else {
                await this.stopScreenShare();
            }
        } catch (e) {
            console.error('Screen share error', e);
        }
    }

    // Dừng chia sẻ: unpublish từng track và stop track local
    private async stopScreenShare() {
        const r = this.room();
        if (!r) return;

        for (const t of this.screenShareTracks) {
            try {
                // unpublish khỏi phòng (tham số thứ 2 = true: dừng track luôn)
                r.localParticipant.unpublishTrack(t, true);
                // vẫn gọi stop() để chắc chắn giải phóng camera/screen capturer
                t.stop();
            } catch {
                // nuốt lỗi “nhỏ” để không chặn vòng lặp
            }
        }

        this.screenShareTracks = [];
        this.isScreenSharing = false;
    }

    // state thêm:
    isCameraOn = false;
    camAndShare = false;

    // refactor: tách startScreenShare() để tái dùng
    private async startScreenShare(audio = true) {
        const r = this.room();
        if (!r) return false;

        try {
            const tracks = await createLocalScreenTracks({ audio }); // audio hệ thống tùy browser/HTTPS
            this.screenShareTracks = tracks as LocalTrack[];

            for (const t of this.screenShareTracks) {
                await r.localParticipant.publishTrack(t);

                // auto-stop khi user bấm "Stop sharing" trên UI của trình duyệt
                const mst = (t as LocalVideoTrack).mediaStreamTrack ?? (t as any).mediaStreamTrack;
                if (mst) {
                    mst.addEventListener(
                        'ended',
                        async () => {
                            await this.stopScreenShare();
                            // nếu đang ở chế độ combo, cập nhật cờ
                            if (this.camAndShare) this.camAndShare = this.isCameraOn && this.isScreenSharing;
                        },
                        { once: true }
                    );
                }
            }

            this.isScreenSharing = true;
            return true;
        } catch (e) {
            console.error('startScreenShare failed', e);
            return false;
        }
    }

    async toggleCamAndShare() {
        const r = this.room();
        if (!r) return;

        try {
            if (!this.camAndShare) {
                // BẬT CAMERA (thử trước camera trước, rồi fallback camera sau)
                this.isCameraOn = false;
                try {
                    await r.localParticipant.setCameraEnabled(true, {
                        facingMode: 'user' as any,
                        resolution: VideoPresets.h540,
                    });
                    this.isCameraOn = true;
                } catch (e1) {
                    console.warn('Front cam failed, try back cam', e1);
                    try {
                        await r.localParticipant.setCameraEnabled(true, {
                            facingMode: 'environment' as any,
                            resolution: VideoPresets.h540,
                        });
                        this.isCameraOn = true;
                    } catch (e2) {
                        console.error('Camera failed, continue without video', e2);
                        // KHÔNG leave room; chỉ không có camera
                        this.isCameraOn = false;
                    }
                }

                // BẬT SCREEN SHARE (nếu chưa bật)
                if (!this.isScreenSharing) {
                    // nếu đang HTTP trên IP, audio hệ thống thường fail -> có thể để false
                    const ok = await this.startScreenShare(true /* hoặc false nếu gặp lỗi */);
                    if (!ok) console.warn('Could not start screen share');
                }

                this.camAndShare = this.isCameraOn || this.isScreenSharing;
            } else {
                // TẮT CẢ HAI
                if (this.isCameraOn) {
                    try {
                        await r.localParticipant.setCameraEnabled(false);
                    } catch {}
                    this.isCameraOn = false;
                }
                if (this.isScreenSharing) await this.stopScreenShare();

                this.camAndShare = false;
            }
        } catch (e) {
            console.error('toggleCamAndShare error', e);
        }
    }

    currentFacing: 'user' | 'environment' = 'user';

    async flipCamera() {
        const r = this.room();
        if (!r) return;

        const next = this.currentFacing === 'user' ? 'environment' : 'user';
        try {
            await r.localParticipant.setCameraEnabled(false);
            await r.localParticipant.setCameraEnabled(true, {
                facingMode: next,
                resolution: VideoPresets.h540, // preset nhẹ cho mobile
            });
            this.currentFacing = next;
        } catch (e) {
            console.error('flipCamera failed', e);
        }
    }
}
