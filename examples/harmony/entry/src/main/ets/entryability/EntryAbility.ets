/**
 * 示例 App 的 UIAbility：只负责加载首页。
 * 生命周期不碰 IM 会话（会话归页面/服务层持有），见 SDK README「架构」一节。
 */
import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';

export default class EntryAbility extends UIAbility {
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {}

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', () => {});
  }
}
