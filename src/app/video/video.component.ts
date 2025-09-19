import { AfterViewInit, Component, ElementRef, OnDestroy, effect, input, viewChild } from '@angular/core';
import { LocalVideoTrack, RemoteVideoTrack, VideoTrack } from 'livekit-client';

@Component({
  selector: 'video-component',
  standalone: true,
  templateUrl: './video.component.html',
  styleUrl: './video.component.css',
})
export class VideoComponent implements AfterViewInit, OnDestroy {
  videoElement = viewChild<ElementRef<HTMLVideoElement>>('videoElement');

  // signals input (Angular 17+)
  track = input.required<LocalVideoTrack | RemoteVideoTrack>();
  participantIdentity = input.required<string>();
  local = input(false);

  // effect để tự attach/detach khi track hoặc element thay đổi
  private attachEffect = effect(() => {
    const el = this.videoElement();            // ElementRef<HTMLVideoElement> | undefined
    const t = this.track() as VideoTrack;      // đảm bảo có track vì là required

    if (el && t) {
      t.attach(el.nativeElement);
      // cleanup khi track/element đổi hoặc component destroy
      return () => t.detach(el.nativeElement);
    }
    return;
  });

  ngAfterViewInit() {
    // Không cần gì thêm: effect ở trên sẽ chạy lại khi viewChild có giá trị
  }

  ngOnDestroy() {
    const el = this.videoElement();
    if (el) this.track().detach(el.nativeElement); // tháo đúng element
  }
}
