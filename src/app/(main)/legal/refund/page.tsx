import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/legal/legal-shell";
import { getSiteConfig } from "@/data/site-config";

export const metadata: Metadata = {
  title: "退款说明",
  description: "AnPPT 积分扣费、失败自动退回、成功交付与充值退款的处理规则。",
  alternates: { canonical: "/legal/refund" },
};

export default function RefundPage() {
  const config = getSiteConfig();
  return (
    <LegalShell
      title="退款说明"
      summary="生成失败不应该让你承担成本。这里说明哪些情况会自动退回积分，哪些情况不支持退款，以及如何联系我们。"
      updatedAt={config.legalUpdatedAt}
    >
      <h2>1. 自动退回积分</h2>
      <p>以下情况通常会在任务失败后自动把未完成部分退回星星余额：</p>
      <ul>
        <li>页面生成失败、上游服务超时或返回错误，且该页尚未成功生成。</li>
        <li>可编辑 PPTX 转换失败，或转换服务暂时不可用。</li>
        <li>因系统异常导致重复扣费、任务中断或状态无法继续。</li>
        <li>你主动取消尚未开始或尚未完成的任务，按实际未消耗部分退回。</li>
      </ul>
      <p>
        自动退回记录会出现在「积分明细」中。若任务显示失败但余额没有变化，
        请先刷新积分明细；仍未恢复时联系我们并提供项目名称和时间。
      </p>

      <h2>2. 不支持退款的情况</h2>
      <ul>
        <li>页面已成功生成并交付，或可编辑文件已成功导出并进入下载中心。</li>
        <li>仅因审美偏好、内容风格不满意或生成后改变主意。</li>
        <li>因你提供的文件损坏、加密、缺少文字、内容错误或版权问题导致的结果不符合预期。</li>
        <li>账号违规、滥用功能、绕过限制或违反 <Link href="/legal/terms">服务条款</Link> 导致的限制或终止。</li>
      </ul>

      <h2>3. 充值退款</h2>
      <p>
        充值属于虚拟服务消费。未使用积分且符合支付渠道规则的充值，可联系客服说明订单号、
        支付时间和退款原因，我们会根据实际使用情况、支付渠道规则和适用法律处理。
        已消耗的积分对应的服务成本通常无法退回。
      </p>

      <h2>4. 处理时效</h2>
      <p>
        自动退回通常在任务失败后即时或几分钟内完成。需要人工核实的订单，我们会在 1 个工作日内回复；
        涉及支付渠道退回的，到账时间以支付渠道为准。
      </p>

      <h2>5. 如何联系</h2>
      <p>
        请发送邮件至 <a href={`mailto:${config.serviceEmail}`}> {config.serviceEmail} </a>，
        并尽量附上：
      </p>
      <ul>
        <li>注册邮箱或手机号；</li>
        <li>订单号或支付凭证（如涉及充值）；</li>
        <li>项目名称、任务时间和页面截图；</li>
        <li>问题的简短描述。</li>
      </ul>
      <p>
        你也可以先查看 <Link href="/help#credits">帮助中心的积分说明</Link>，
        或在 <Link href="/account/credits">积分明细</Link> 中确认扣费和退回记录。
      </p>
    </LegalShell>
  );
}
