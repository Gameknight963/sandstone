export function static_module_type(node){
  let type='javascript';
  for(const attribute of node.attributes||[]){
    if((attribute.key.name??attribute.key.value)!=='type')throw new SyntaxError('Unsupported module import attribute');
    type=attribute.value.value;
    if(type!=='json'&&type!=='css')throw new TypeError('Unsupported module import type');
  }
  return type;
}
