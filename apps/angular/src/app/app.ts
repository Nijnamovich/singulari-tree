import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LayoutComponent } from './core/layout/layout';

@Component({
  selector: 'st-root',
  standalone: true,
  imports: [LayoutComponent],
  template: `<st-layout />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  readonly title = 'SingulariTree';
}
